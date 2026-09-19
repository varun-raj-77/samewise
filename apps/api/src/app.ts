import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CandidateEvidenceDetailSchema,
  BatchIdentityDecisionInputSchema,
  BatchIdentityDecisionResponseSchema,
  ConflictPageSchema,
  ManualMappingSchema,
  MappingSuggestionDecisionSchema,
  MappingSuggestionResponseSchema,
  HumanReviewEvidenceSchema,
  ResolutionPreviewSchema,
  ResultsPageSchema,
  ReviewFilterSchema,
  ReviewQueuePageSchema,
  ReviewGroupListSchema,
  ReviewGroupPreviewSchema,
  ReviewSortSchema,
  RunManifestSchema,
  RuleApplicationResponseSchema,
  RunViewSchema,
  RunSummarySchema,
  SurvivorshipPolicyInputSchema,
  createHealthResponse,
} from "@samewise/contracts";
import Fastify, { type FastifyInstance } from "fastify";

import { createMatcherRunner, type MatcherRunner } from "./matcher-process.js";
import { EvaluationStore, humanReviewEvidence } from "./evaluation-store.js";
import { createSemanticMapperFromEnvironment, type SemanticMapper } from "./semantic-mapper.js";
import { DEFAULT_PAGE_LIMIT, MAX_CSV_BYTES, MAX_PAGE_LIMIT, WorkflowError, WorkflowStore } from "./workflow-store.js";

interface BuildAppOptions {
  dataRoot?: string;
  logger?: boolean;
  matcher?: MatcherRunner;
  semanticMapper?: SemanticMapper;
  evaluationRoot?: string;
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

function pageQuery(value: unknown): { offset: number; limit: number } {
  const query = value as { offset?: string; limit?: string };
  const parse = (raw: string | undefined, fallback: number, minimum: number) => {
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw new WorkflowError("invalid_pagination", "Pagination values must be non-negative integers.");
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new WorkflowError("invalid_pagination", "Pagination values are outside the supported range.");
    return parsed;
  };
  return {
    offset: parse(query.offset, 0, 0),
    limit: Math.min(MAX_PAGE_LIMIT, parse(query.limit, DEFAULT_PAGE_LIMIT, 1)),
  };
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_CSV_BYTES });
  const store = new WorkflowStore(
    options.dataRoot ?? resolve(process.cwd(), ".samewise-data"),
    options.matcher ?? createMatcherRunner(),
    options.semanticMapper ?? createSemanticMapperFromEnvironment(),
  );
  const evaluations = new EvaluationStore(
    options.evaluationRoot ?? fileURLToPath(new URL("../../../evaluation/reports/sw-009/", import.meta.url)),
  );

  app.addContentTypeParser(
    ["text/csv", "application/csv", "application/vnd.ms-excel"],
    { parseAs: "buffer", bodyLimit: MAX_CSV_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.get("/api/health", async () => createHealthResponse("api"));

  app.get("/api/evaluations", async () => evaluations.catalog());

  app.get("/api/evaluations/:evaluationId", async (request) => {
    const { evaluationId } = routeParams(request.params);
    const snapshot = evaluationId ? await evaluations.snapshot(evaluationId) : null;
    if (!snapshot) throw new WorkflowError("evaluation_not_found", "Evaluation snapshot was not found.", 404);
    return snapshot;
  });

  app.get("/api/evaluations/:evaluationId/comparison/:otherId", async (request) => {
    const { evaluationId, otherId } = routeParams(request.params);
    const comparison = evaluationId && otherId ? await evaluations.comparison(evaluationId, otherId) : null;
    if (!comparison) throw new WorkflowError("comparison_not_found", "Evaluation comparison was not found.", 404);
    return comparison;
  });

  app.get("/api/evaluations/:evaluationId/errors", async (request) => {
    const { evaluationId } = routeParams(request.params);
    const query = request.query as { type?: string; offset?: string; limit?: string };
    const groups = ["candidate_misses", "ranking_losses", "post_score_losses", "false_auto_matches", "false_unmatched", "hard_negatives"] as const;
    const group = groups.find((value) => value === query.type);
    if (!evaluationId || !group) throw new WorkflowError("invalid_request", "A valid evaluation error type is required.");
    const offset = Math.max(0, Number.parseInt(query.offset ?? "0", 10) || 0);
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? "20", 10) || 20));
    return evaluations.errorPage(evaluationId, group, offset, limit);
  });

  app.post("/api/runs", async (_request, reply) => {
    const view = RunSummarySchema.parse(store.createRun());
    app.log.info({ runId: view.runId, stage: view.stage }, "run created");
    reply.code(201);
    return view;
  });

  app.get("/api/runs/:runId", async (request) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    return RunSummarySchema.parse(store.get(runId));
  });

  app.get("/api/runs/:runId/results", async (request) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const { offset, limit } = pageQuery(request.query);
    return ResultsPageSchema.parse(store.resultsPage(runId, offset, limit));
  });

  app.get("/api/runs/:runId/review", async (request) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const { offset, limit } = pageQuery(request.query);
    const query = request.query as { filter?: string; sort?: string; q?: string };
    if ((query.q?.length ?? 0) > 200) throw new WorkflowError("invalid_request", "Review search is limited to 200 characters.");
    const filter = ReviewFilterSchema.parse(query.filter ?? "unresolved");
    const sort = ReviewSortSchema.parse(query.sort ?? "ambiguity");
    return ReviewQueuePageSchema.parse(store.reviewPage(runId, offset, limit, filter, sort, query.q ?? ""));
  });

  app.get("/api/runs/:runId/review-groups", async (request) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    return ReviewGroupListSchema.parse(store.reviewGroups(runId));
  });

  app.get("/api/runs/:runId/review-groups/:groupId", async (request) => {
    const { runId, groupId } = routeParams(request.params);
    if (!runId || !groupId) throw new WorkflowError("invalid_request", "Run ID and review group are required.");
    const { offset, limit } = pageQuery(request.query);
    return ReviewGroupPreviewSchema.parse(store.reviewGroupPreview(runId, groupId, offset, limit));
  });

  app.post("/api/runs/:runId/review-groups/:groupId/decisions", async (request) => {
    const { runId, groupId } = routeParams(request.params);
    if (!runId || !groupId) throw new WorkflowError("invalid_request", "Run ID and review group are required.");
    const input = BatchIdentityDecisionInputSchema.parse(request.body);
    const result = store.batchDecide(runId, groupId, input.decision);
    app.log.info({ runId, stage: "review", groupId, decision: input.decision, appliedCount: result.appliedCount, excludedCount: result.excludedCount }, "batch identity decision recorded");
    return BatchIdentityDecisionResponseSchema.parse(result);
  });

  app.get("/api/runs/:runId/candidates/:candidateId", async (request) => {
    const { runId, candidateId } = routeParams(request.params);
    if (!runId || !candidateId) throw new WorkflowError("invalid_request", "Run ID and candidate ID are required.");
    return CandidateEvidenceDetailSchema.parse(store.candidateDetail(runId, candidateId));
  });

  app.get("/api/runs/:runId/conflicts", async (request) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const { offset, limit } = pageQuery(request.query);
    return ConflictPageSchema.parse(store.conflictPage(runId, offset, limit));
  });

  app.get("/api/runs/:runId/evaluation-evidence", async (request) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    return HumanReviewEvidenceSchema.parse(humanReviewEvidence(RunViewSchema.parse(store.evaluationView(runId))));
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
    return RunSummarySchema.parse(view);
  });

  app.put("/api/runs/:runId/mappings", async (request) => {
    const { runId } = routeParams(request.params);
    const body = objectBody(request.body);
    if (!runId || !Array.isArray(body.mappings) || body.mappings.length === 0) throw new WorkflowError("invalid_request", "At least one mapping is required.");
    const mappings = body.mappings.map((mapping) => ManualMappingSchema.parse(mapping));
    const view = RunSummarySchema.parse(store.setMappings(runId, mappings));
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
    const view = RunSummarySchema.parse(await store.match(runId));
    app.log.info({ runId, stage: "results", matcherVersion: view.matcherVersion, ...view.summary }, "match completed");
    return view;
  });

  app.post("/api/runs/:runId/candidates/:candidateId/decisions", async (request) => {
    const { runId, candidateId } = routeParams(request.params);
    const decision = objectBody(request.body).decision;
    if (!runId || !candidateId || (decision !== "same_entity" && decision !== "different_entity")) throw new WorkflowError("invalid_request", "A valid identity decision is required.");
    const view = RunSummarySchema.parse(store.decide(runId, candidateId, decision));
    app.log.info({ runId, stage: "review", candidateId, decision, matcherVersion: view.matcherVersion }, "identity decision recorded");
    return view;
  });

  app.patch("/api/runs/:runId/review-items/:aRowId", async (request) => {
    const { runId, aRowId } = routeParams(request.params);
    const deferred = objectBody(request.body).deferred;
    if (!runId || !aRowId || typeof deferred !== "boolean") {
      throw new WorkflowError("invalid_request", "A review item and deferred state are required.");
    }
    const view = RunSummarySchema.parse(store.setDeferred(runId, aRowId, deferred));
    app.log.info({ runId, stage: "review", aRowId, deferred }, "review item defer state changed");
    return view;
  });

  app.post("/api/runs/:runId/review-undo", async (request) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const view = RunSummarySchema.parse(store.undo(runId));
    app.log.info({ runId, stage: "review", undoneCandidateId: view.reviewUndo?.candidateId ?? null }, "review decision undone");
    return view;
  });

  app.post("/api/runs/:runId/conflicts/:conflictId/resolutions", async (request) => {
    const { runId, conflictId } = routeParams(request.params);
    const action = objectBody(request.body).action;
    const replace = objectBody(request.body).replace;
    if (!runId || !conflictId || (action !== "use_a" && action !== "use_b" && action !== "keep_both") || (replace !== undefined && typeof replace !== "boolean")) throw new WorkflowError("invalid_request", "A valid field-resolution action is required.");
    const view = RunSummarySchema.parse(store.resolveConflict(runId, conflictId, action, replace === true));
    app.log.info({ runId, stage: "resolution", conflictId, action }, "field resolution recorded");
    return view;
  });

  app.delete("/api/runs/:runId/conflicts/:conflictId/resolution", async (request) => {
    const { runId, conflictId } = routeParams(request.params);
    if (!runId || !conflictId) throw new WorkflowError("invalid_request", "Run ID and conflict ID are required.");
    const view = RunSummarySchema.parse(store.clearResolution(runId, conflictId));
    app.log.info({ runId, stage: "resolution", conflictId }, "field resolution cleared");
    return view;
  });

  app.put("/api/runs/:runId/survivorship-policy", async (request) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const policy = SurvivorshipPolicyInputSchema.parse(request.body);
    const view = RunSummarySchema.parse(store.setSurvivorshipPolicy(runId, policy));
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
    return RuleApplicationResponseSchema.parse({ ...result, run: RunSummarySchema.parse(result.run) });
  });

  app.get("/api/runs/:runId/export", async (request, reply) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const artifact = store.exportSnapshot(runId).reconciliation;
    app.log.info({ runId, stage: "export" }, "reconciliation export created");
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${artifact.filename}"`);
    return artifact.content;
  });

  app.get("/api/runs/:runId/trusted-export", async (request, reply) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const artifact = store.exportSnapshot(runId).trusted;
    if (!artifact) {
      const view = store.get(runId);
      throw new WorkflowError("trusted_export_not_ready", `Trusted merged output is blocked: ${view.trustedExportReadiness.blockers.join(" ")}`, 409);
    }
    app.log.info({ runId, stage: "trusted_export" }, "trusted merged export created");
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${artifact.filename}"`);
    return artifact.content;
  });

  app.get("/api/runs/:runId/manifest", async (request, reply) => {
    const { runId } = routeParams(request.params);
    if (!runId) throw new WorkflowError("invalid_request", "Run ID is required.");
    const artifact = store.exportSnapshot(runId).manifest;
    RunManifestSchema.parse(artifact.value);
    app.log.info({ runId, stage: "manifest_export" }, "run provenance manifest created");
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${artifact.filename}"`);
    return artifact.content;
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
