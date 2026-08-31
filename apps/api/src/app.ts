import { resolve } from "node:path";

import {
  ManualMappingSchema,
  RunViewSchema,
  createHealthResponse,
} from "@samewise/contracts";
import Fastify, { type FastifyInstance } from "fastify";

import { createMatcherRunner, type MatcherRunner } from "./matcher-process.js";
import { exportRun, MAX_CSV_BYTES, WorkflowError, WorkflowStore } from "./workflow-store.js";

interface BuildAppOptions {
  dataRoot?: string;
  logger?: boolean;
  matcher?: MatcherRunner;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowError("invalid_request", "Request data did not match the required contract.");
  }
  return value as Record<string, unknown>;
}

function routeParams(value: unknown): Record<string, string> {
  return value as Record<string, string>;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_CSV_BYTES });
  const store = new WorkflowStore(
    options.dataRoot ?? resolve(process.cwd(), ".samewise-data"),
    options.matcher ?? createMatcherRunner(),
  );

  app.addContentTypeParser(
    ["text/csv", "application/csv", "application/vnd.ms-excel"],
    { parseAs: "buffer", bodyLimit: MAX_CSV_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.get("/api/health", async () => createHealthResponse("api"));

  app.post("/api/runs", async (_request, reply) => {
    const view = RunViewSchema.parse(store.createRun());
    app.log.info({ runId: view.runId, stage: view.stage }, "run created");
    reply.code(201);
    return view;
  });

  app.get("/api/runs/:runId", async (request) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    return RunViewSchema.parse(store.get(runId));
  });

  app.post("/api/runs/:runId/datasets/:side", async (request, reply) => {
    const { runId, side } = routeParams(request.params);
    if (!runId || (side !== "A" && side !== "B")) throw new WorkflowError("invalid_request", "Run ID and dataset side are required.");
    if (!Buffer.isBuffer(request.body)) {
      throw new WorkflowError("unsupported_file_type", "Upload a CSV file using a CSV content type.", 415);
    }
    const view = await store.upload(runId, side, request.headers["x-file-name"] as string | undefined, request.body);
    const dataset = view.datasets[side];
    app.log.info({ runId, stage: "profile", datasetId: dataset?.datasetId, side, rowCount: dataset?.rowCount }, "dataset profiled");
    reply.code(201);
    return RunViewSchema.parse(view);
  });

  app.put("/api/runs/:runId/mappings", async (request) => {
    const { runId } = routeParams(request.params);
    const body = objectBody(request.body);
    if (!runId || !Array.isArray(body.mappings) || body.mappings.length === 0) throw new WorkflowError("invalid_request", "At least one mapping is required.");
    const mappings = body.mappings.map((mapping) => ManualMappingSchema.parse(mapping));
    const view = RunViewSchema.parse(store.setMappings(runId, mappings));
    app.log.info({ runId, stage: "mapping", mappingCount: mappings.length }, "mappings saved");
    return view;
  });

  app.post("/api/runs/:runId/match", async (request) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const view = RunViewSchema.parse(await store.match(runId));
    app.log.info({ runId, stage: "results", matcherVersion: view.matcherVersion, ...view.summary }, "baseline match completed");
    return view;
  });

  app.post("/api/runs/:runId/candidates/:candidateId/decisions", async (request) => {
    const { runId, candidateId } = routeParams(request.params);
    const decision = objectBody(request.body).decision;
    if (!runId || !candidateId || (decision !== "same_entity" && decision !== "different_entity")) throw new WorkflowError("invalid_request", "A valid identity decision is required.");
    const view = RunViewSchema.parse(store.decide(runId, candidateId, decision));
    app.log.info({ runId, stage: "review", candidateId, decision, matcherVersion: view.matcherVersion }, "identity decision recorded");
    return view;
  });

  app.post("/api/runs/:runId/conflicts/:conflictId/resolutions", async (request) => {
    const { runId, conflictId } = routeParams(request.params);
    const action = objectBody(request.body).action;
    if (!runId || !conflictId || (action !== "use_a" && action !== "use_b")) throw new WorkflowError("invalid_request", "A valid field-resolution action is required.");
    const view = RunViewSchema.parse(store.resolveConflict(runId, conflictId, action));
    app.log.info({ runId, stage: "resolution", conflictId, action }, "field resolution recorded");
    return view;
  });

  app.get("/api/runs/:runId/export", async (request, reply) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const csv = exportRun(store.get(runId));
    app.log.info({ runId, stage: "export" }, "reconciliation export created");
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="samewise-${runId}.csv"`);
    return csv;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof WorkflowError) {
      app.log.warn({ errorCategory: error.code }, "Samewise request rejected");
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    const genericError = error as { name?: string; statusCode?: number };
    if (genericError.name === "ZodError") {
      return reply.code(400).send({ error: { code: "invalid_request", message: "Request data did not match the required contract." } });
    }
    if (genericError.statusCode === 413) {
      return reply.code(413).send({ error: { code: "file_too_large", message: "CSV file exceeds the 2 MiB development limit." } });
    }
    if (genericError.statusCode === 415) {
      return reply.code(415).send({ error: { code: "unsupported_file_type", message: "Upload a CSV file using a CSV content type." } });
    }
    app.log.error({ errorCategory: "internal_error" }, "Samewise request failed");
    return reply.code(500).send({ error: { code: "internal_error", message: "Samewise could not complete the request." } });
  });

  return app;
}
