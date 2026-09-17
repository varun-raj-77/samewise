import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  DatasetProfileSchema,
  CandidateEvidenceDetailSchema,
  ManualMappingSchema,
  MATCHER_VERSION,
  PaginationSchema,
  ResultsPageSchema,
  ReviewQueuePageSchema,
  RunSummarySchema,
  WORKFLOW_CONTRACT_VERSION,
  WORKFLOW_PROJECTION_CONTRACT_VERSION,
} from "../src/index.js";

describe("SW-003 workflow contract", () => {
  it("keeps language-neutral version and matcher literals synchronized", async () => {
    const path = new URL("../schemas/workflow/1.0.0.json", import.meta.url);
    const schema = JSON.parse(await readFile(path, "utf8")) as {
      "x-contract-version": string;
      "x-projection-contract-version": string;
      $defs: { matcherVersion: { const: string } };
    };
    expect(schema["x-contract-version"]).toBe(WORKFLOW_CONTRACT_VERSION);
    expect(schema["x-projection-contract-version"]).toBe(WORKFLOW_PROJECTION_CONTRACT_VERSION);
    expect(schema.$defs.matcherVersion.const).toBe(MATCHER_VERSION);
  });

  it("rejects extra fields and invalid mapping roles", () => {
    expect(ManualMappingSchema.safeParse({
      mappingId: "m1", label: "Name", aColumn: "name", bColumn: "organization",
      role: "winner", normalizer: "text",
    }).success).toBe(false);
  });

  it("classifies shared manual-mapping examples with Zod", async () => {
    const path = new URL("../examples/workflow/1.0.0.json", import.meta.url);
    const examples = JSON.parse(await readFile(path, "utf8")) as {
      manualMappings: { valid: { name: string; value: unknown }[]; invalid: { name: string; value: unknown }[] };
      runSummaries: { valid: { name: string; value: unknown }[]; invalid: { name: string; value: unknown }[] };
    };
    for (const example of examples.manualMappings.valid) {
      expect(ManualMappingSchema.safeParse(example.value).success, example.name).toBe(true);
    }
    for (const example of examples.manualMappings.invalid) {
      expect(ManualMappingSchema.safeParse(example.value).success, example.name).toBe(false);
    }
    for (const example of examples.runSummaries.valid) {
      expect(RunSummarySchema.safeParse(example.value).success, example.name).toBe(true);
    }
    for (const example of examples.runSummaries.invalid) {
      expect(RunSummarySchema.safeParse(example.value).success, example.name).toBe(false);
    }
  });

  it("validates a bounded dataset profile", () => {
    expect(DatasetProfileSchema.parse({
      contractVersion: "1.0.0", datasetId: "dataset-a", side: "A", originalFilename: "a.csv",
      sha256: "a".repeat(64), rowCount: 1,
      columns: [{ name: "name", inferredType: "string", nullCount: 0, nullRate: 0, distinctCount: 1, distinctRate: 1, samples: ["Acme"] }],
    }).rowCount).toBe(1);
  });

  it("validates explicit bounded projection contracts and enforces the page maximum", () => {
    const summary = RunSummarySchema.parse({
      contractVersion: "1.0.0", projectionVersion: "1.0.0", runId: "run-1", stage: "results",
      datasets: {}, mappings: [], mappingVersion: "confirmed-mappings-v1", semanticMappingProvenance: null,
      matcherVersion: null, matcherProvenance: null, summary: null, survivorshipPolicy: null,
      trustedExportReadiness: { ready: false, unresolvedIdentityCount: 0, unresolvedConflictCount: 0, eligibleConfirmedCount: 0, onlyACount: 0, onlyBCount: 0, blockers: ["The matcher has not completed."] },
      reviewProgress: { total: 0, reviewed: 0, remaining: 0, deferred: 0 }, reviewUndo: null,
      conflictSummary: { total: 0, resolved: 0, unresolved: 0 },
    });
    expect(summary).not.toHaveProperty("candidates");
    expect(PaginationSchema.safeParse({ offset: 0, limit: 101, total: 0, returned: 0, nextOffset: null, previousOffset: null }).success).toBe(false);
    const page = { offset: 0, limit: 50, total: 0, returned: 0, nextOffset: null, previousOffset: null };
    expect(ResultsPageSchema.parse({ contractVersion: "1.0.0", runId: "run-1", items: [], page, ordering: "a_row_id_ascending" }).items).toEqual([]);
    expect(ReviewQueuePageSchema.parse({ contractVersion: "1.0.0", runId: "run-1", items: [], page, progress: summary.reviewProgress, filter: "unresolved", sort: "source", query: "" }).items).toEqual([]);
  });

  it("validates complete candidate evidence independently from queue summaries", () => {
    const evidence = { mappingId: "name", label: "Name", aColumn: "name", bColumn: "name", aValue: "Acme", bValue: "Acme", normalizedA: "acme", normalizedB: "acme", fieldKind: "name", featurePipelineVersion: "feature-pipeline-v0.1.0", features: [{ name: "exact", value: 1 }], outcome: "exact", evidenceClass: "exact_agreement", weight: 1, positiveContribution: 1, conflictContribution: 0, contribution: 1, explanationCode: "exact", explanation: "Exact agreement." };
    const candidate = { candidateId: "candidate-1", aRowId: "A1", bRowId: "B1", aRecord: { name: "Acme" }, bRecord: { name: "Acme" }, rank: 1, matchScore: 1, runnerUpMargin: 1, band: "needs_review", collision: false, strongContradiction: false, blockingEvidence: [{ blockerId: "exact", keyHash: "0123456789abcdef" }], positiveEvidence: 1, conflictEvidence: 0, totalWeight: 1, evidence: [evidence] };
    const candidateSummary = { candidateId: "candidate-1", bRowId: "B1", rank: 1, matchScore: 1, band: "needs_review", collision: false, strongContradiction: false, strongestPositive: { mappingId: "name", label: "Name", evidenceClass: "exact_agreement", contribution: 1 }, strongestContradiction: null, humanDecision: null };
    const detail = CandidateEvidenceDetailSchema.parse({ contractVersion: "1.0.0", runId: "run-1", candidate, alternatives: [candidateSummary], reviewState: "needs_review", deferred: false, collisionARowIds: [], effectiveCollisionARowIds: [], humanDecision: null, conflicts: [], matcherVersion: "explainable-matcher-v0.2.0", candidateEngineVersion: "candidate-engine-v0.2.0" });
    expect(detail.candidate.evidence).toEqual([evidence]);
  });
});
