import { resolve } from "node:path";

import {
  ManualMappingSchema,
  MappingSuggestionDecisionSchema,
  MappingSuggestionResponseSchema,
  ResolutionPreviewSchema,
  RuleApplicationResponseSchema,
  RunViewSchema,
  SurvivorshipPolicyInputSchema,
  createHealthResponse,
} from "@samewise/contracts";
import Fastify, { type FastifyInstance } from "fastify";

import { createMatcherRunner, type MatcherRunner } from "./matcher-process.js";
import { createSemanticMapperFromEnvironment, type SemanticMapper } from "./semantic-mapper.js";
import { exportRun, exportTrustedRun, MAX_CSV_BYTES, WorkflowError, WorkflowStore } from "./workflow-store.js";

interface BuildAppOptions {
  dataRoot?: string;
  logger?: boolean;
  matcher?: MatcherRunner;
  semanticMapper?: SemanticMapper;
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
    options.semanticMapper ?? createSemanticMapperFromEnvironment(),
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

  app.post("/api/runs/:runId/mapping-suggestions", async (request, reply) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const response = MappingSuggestionResponseSchema.parse(await store.generateMappingSuggestions(runId));
    app.log.info({
      runId,
      stage: "mapping_suggestions",
      model: response.proposal.provenance.model,
      promptVersion: response.proposal.provenance.promptVersion,
      suggestionCount: response.proposal.suggestions.length,
    }, "semantic mapping suggestions created");
    reply.code(201);
    return response;
  });

  app.patch("/api/runs/:runId/mapping-suggestions/:suggestionId", async (request) => {
    const { runId, suggestionId } = routeParams(request.params);
    if (!runId || !suggestionId) throw new WorkflowError("invalid_request", "Run ID and suggestion ID are required.");
    const decision = MappingSuggestionDecisionSchema.parse(request.body);
    const response = MappingSuggestionResponseSchema.parse(store.decideMappingSuggestion(runId, suggestionId, decision));
    app.log.info({ runId, stage: "mapping_review", suggestionId, decision: decision.decision }, "mapping suggestion reviewed");
    return response;
  });

  app.post("/api/runs/:runId/match", async (request) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const view = RunViewSchema.parse(await store.match(runId));
    app.log.info({ runId, stage: "results", matcherVersion: view.matcherVersion, ...view.summary }, "match completed");
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

  app.patch("/api/runs/:runId/review-items/:aRowId", async (request) => {
    const { runId, aRowId } = routeParams(request.params);
    const deferred = objectBody(request.body).deferred;
    if (!runId || !aRowId || typeof deferred !== "boolean") {
      throw new WorkflowError("invalid_request", "A review item and deferred state are required.");
    }
    const view = RunViewSchema.parse(store.setDeferred(runId, aRowId, deferred));
    app.log.info({ runId, stage: "review", aRowId, deferred }, "review item defer state changed");
    return view;
  });

  app.post("/api/runs/:runId/review-undo", async (request) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const view = RunViewSchema.parse(store.undo(runId));
    app.log.info({ runId, stage: "review", undoneCandidateId: view.reviewUndo?.candidateId ?? null }, "review decision undone");
    return view;
  });

  app.post("/api/runs/:runId/conflicts/:conflictId/resolutions", async (request) => {
    const { runId, conflictId } = routeParams(request.params);
    const action = objectBody(request.body).action;
    const replace = objectBody(request.body).replace;
    if (!runId || !conflictId || (action !== "use_a" && action !== "use_b" && action !== "keep_both") || (replace !== undefined && typeof replace !== "boolean")) throw new WorkflowError("invalid_request", "A valid field-resolution action is required.");
    const view = RunViewSchema.parse(store.resolveConflict(runId, conflictId, action, replace === true));
    app.log.info({ runId, stage: "resolution", conflictId, action }, "field resolution recorded");
    return view;
  });

  app.delete("/api/runs/:runId/conflicts/:conflictId/resolution", async (request) => {
    const { runId, conflictId } = routeParams(request.params);
    if (!runId || !conflictId) throw new WorkflowError("invalid_request", "Run ID and conflict ID are required.");
    const view = RunViewSchema.parse(store.clearResolution(runId, conflictId));
    app.log.info({ runId, stage: "resolution", conflictId }, "field resolution cleared");
    return view;
  });

  app.put("/api/runs/:runId/survivorship-policy", async (request) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const policy = SurvivorshipPolicyInputSchema.parse(request.body);
    const view = RunViewSchema.parse(store.setSurvivorshipPolicy(runId, policy));
    app.log.info({ runId, stage: "resolution", policyVersion: view.survivorshipPolicy?.policyVersion }, "survivorship policy configured without applying it");
    return view;
  });

  app.post("/api/runs/:runId/survivorship-preview", async (request) => {
    const { runId } = routeParams(request.params);
    const ruleId = objectBody(request.body).ruleId;
    if (!runId || typeof ruleId !== "string" || !ruleId) throw new WorkflowError("invalid_request", "A configured survivorship rule is required.");
    return ResolutionPreviewSchema.parse(store.previewSurvivorshipRule(runId, ruleId));
  });

  app.post("/api/runs/:runId/survivorship-apply", async (request) => {
    const { runId } = routeParams(request.params);
    const ruleId = objectBody(request.body).ruleId;
    if (!runId || typeof ruleId !== "string" || !ruleId) throw new WorkflowError("invalid_request", "A configured survivorship rule is required.");
    const result = store.applySurvivorshipRule(runId, ruleId);
    app.log.info({ runId, stage: "resolution", ruleId, policyVersion: result.policyVersion, appliedCount: result.appliedCount }, "survivorship rule explicitly applied");
    return RuleApplicationResponseSchema.parse({ ...result, run: RunViewSchema.parse(result.run) });
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

  app.get("/api/runs/:runId/trusted-export", async (request, reply) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const csv = exportTrustedRun(store.get(runId));
    app.log.info({ runId, stage: "trusted_export" }, "trusted merged export created");
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="samewise-trusted-${runId}.csv"`);
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
