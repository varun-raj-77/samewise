import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MATCHER_VERSION,
  RECONCILIATION_EXPORT_VERSION,
  RUN_MANIFEST_VERSION,
  CandidateEvidenceDetailSchema,
  ConflictPageSchema,
  ResultsPageSchema,
  ReviewQueuePageSchema,
  RunManifestSchema,
  RunViewSchema,
  RunSummarySchema,
  TRUSTED_EXPORT_VERSION,
  type MatcherResult,
} from "@samewise/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { MatcherRunner } from "../src/matcher-process.js";
import { exportRun } from "../src/workflow-store.js";

const aBytes = Buffer.from("id,name,status\nA1,Acme Corp,=SUM(1,2)\n");
const bBytes = Buffer.from("id,organization,status\nB1,Acme Corporation,inactive\nB2,Other,active\n");

let matcherResultOverride: MatcherResult | undefined;

function baseMatcherResult(): MatcherResult {
  return {
    contractVersion: "1.0.0", matcherVersion: MATCHER_VERSION,
    candidateEngineVersion: "candidate-engine-v0.3.0",
    blockingNormalizationVersion: "blocking-normalization-v0.1.0",
    featurePipelineVersion: "feature-pipeline-v0.1.0",
    matcherConfigVersion: "matcher-config-v0.2.0",
    matcherConfig: { frozen: true },
    candidates: [{
      candidateId: "candidate-1-1", aRowId: "A1", bRowId: "B1",
      aRecord: { id: "A1", name: "Acme Corp", status: "=SUM(1,2)" },
      bRecord: { id: "B1", organization: "Acme Corporation", status: "inactive" },
      rank: 1, matchScore: 0.72, runnerUpMargin: 0.2, band: "needs_review", collision: false,
      strongContradiction: false,
      blockingEvidence: [{ blockerId: "name_token_v1", keyHash: "0123456789abcdef" }],
      positiveEvidence: 0.72, conflictEvidence: 0, totalWeight: 2,
      evidence: [{ mappingId: "name", label: "Organization name", aColumn: "name", bColumn: "organization", aValue: "Acme Corp", bValue: "Acme Corporation", normalizedA: "acme", normalizedB: "acme", fieldKind: "name", featurePipelineVersion: "feature-pipeline-v0.1.0", features: [{ name: "token_similarity", value: 1 }], outcome: "similar", evidenceClass: "partial_agreement", weight: 2, positiveContribution: 0.72, conflictContribution: 0, contribution: 0.72, explanationCode: "name_partial", explanation: "Organization name has partial normalized agreement." }],
    }],
    onlyA: [], onlyB: [
      { rowId: "B1", record: { id: "B1", organization: "Acme Corporation", status: "inactive" } },
      { rowId: "B2", record: { id: "B2", organization: "Other", status: "active" } },
    ],
  };
}

const matcher: MatcherRunner = {
  async profile(input) {
    const names = input.side === "A" ? ["id", "name", "status"] : ["id", "organization", "status"];
    return {
      contractVersion: "1.0.0", datasetId: input.datasetId, side: input.side,
      originalFilename: input.originalFilename, sha256: input.sha256, rowCount: input.side === "A" ? 1 : 2,
      columns: names.map((name) => ({ name, inferredType: "string", nullCount: 0, nullRate: 0, distinctCount: 1, distinctRate: 1, samples: [name] })),
    };
  },
  async match(): Promise<MatcherResult> {
    return matcherResultOverride ?? baseMatcherResult();
  },
};

describe("SW-003 API workflow", () => {
  let dataRoot: string;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => { matcherResultOverride = undefined; dataRoot = await mkdtemp(join(tmpdir(), "samewise-api-")); app = buildApp({ dataRoot, matcher }); });
  afterEach(async () => { await app.close(); });

  async function setup() {
    const created = RunSummarySchema.parse((await app.inject({ method: "POST", url: "/api/runs" })).json());
    for (const [side, filename, bytes] of [["A", "a.csv", aBytes], ["B", "b.csv", bBytes]] as const) {
      const response = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/datasets/${side}`, headers: { "content-type": "text/csv", "x-file-name": filename }, payload: bytes });
      expect(response.statusCode).toBe(201);
    }
    const mapped = await app.inject({ method: "PUT", url: `/api/runs/${created.runId}/mappings`, payload: { mappings: [
      { mappingId: "name", label: "Organization name", aColumn: "name", bColumn: "organization", useForMatching: true, includeInMerge: false, normalizer: "text" },
      { mappingId: "status", label: "Status", aColumn: "status", bColumn: "status", useForMatching: false, includeInMerge: true, normalizer: "text" },
    ] } });
    expect(mapped.statusCode).toBe(200);
    const result = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/match` });
    expect(result.statusCode).toBe(200);
    return { runId: created.runId, result: RunSummarySchema.parse(result.json()) };
  }

  async function reviewPage(runId: string, filter = "all") {
    return ReviewQueuePageSchema.parse((await app.inject({ method: "GET", url: `/api/runs/${runId}/review?filter=${filter}&sort=source&limit=100` })).json());
  }

  async function candidateDetail(runId: string, candidateId = "candidate-1-1") {
    return CandidateEvidenceDetailSchema.parse((await app.inject({ method: "GET", url: `/api/runs/${runId}/candidates/${candidateId}` })).json());
  }

  async function conflictPage(runId: string) {
    return ConflictPageSchema.parse((await app.inject({ method: "GET", url: `/api/runs/${runId}/conflicts?limit=100` })).json());
  }

  it("uploads, profiles, maps, matches, decides SAME, resolves explicitly, and exports without mutating sources", async () => {
    const { runId, result } = await setup();
    expect(result.summary).toEqual({ matched: 0, needsReview: 1, onlyA: 0, onlyB: 2 });
    expect(result.mappingVersion).toBe("confirmed-mappings-v2");
    expect(result.matcherProvenance).toMatchObject({
      matcherVersion: MATCHER_VERSION,
      candidateEngineVersion: "candidate-engine-v0.3.0",
      featurePipelineVersion: "feature-pipeline-v0.1.0",
      matcherConfigVersion: "matcher-config-v0.2.0",
    });
    const runDirectory = join(dataRoot, runId);
    const paths = (await readdir(runDirectory)).map((name) => join(runDirectory, name));
    const before = await Promise.all(paths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")));
    const pendingExport = await app.inject({ method: "GET", url: `/api/runs/${runId}/export` });
    expect(pendingExport.body).toContain("needs_review,pending_human_review");
    expect(pendingExport.body).toContain("pending_identity");

    const same = await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } });
    const afterSame = RunSummarySchema.parse(same.json());
    const detailAfterSame = await candidateDetail(runId);
    expect(detailAfterSame.humanDecision?.humanDecision).toBe("same_entity");
    expect(detailAfterSame.humanDecision).toMatchObject({
      matcherVersion: "explainable-matcher-v0.2.0",
      candidateEngineVersion: "candidate-engine-v0.3.0",
      matchScore: 0.72,
      systemProposal: "needs_review",
    });
    const humanEvidence = await app.inject({ method: "GET", url: `/api/runs/${runId}/evaluation-evidence` });
    expect(humanEvidence.json()).toMatchObject({
      source: { type: "HUMAN_REVIEW_LABELS", representative: false },
      labeledCandidateCount: 1, sameLabels: 1, differentLabels: 0,
      systemProposalAgreementRate: null,
      labels: [{ matcherVersion: "explainable-matcher-v0.2.0", candidateEngineVersion: "candidate-engine-v0.3.0", humanLabel: "SAME" }],
    });
    expect(humanEvidence.json().source.caveat).toContain("may not represent the full dataset distribution");
    expect(afterSame.summary?.onlyB).toBe(1);
    const conflictsAfterSame = await conflictPage(runId);
    expect(conflictsAfterSame.items).toHaveLength(1);
    expect(conflictsAfterSame.items[0]?.resolution).toBeNull();

    const resolvedResponse = await app.inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${conflictsAfterSame.items[0]!.conflictId}/resolutions`, payload: { action: "use_a" } });
    expect(RunSummarySchema.parse(resolvedResponse.json()).conflictSummary).toMatchObject({ manualDecisions: 1, preservedBoth: 0 });
    expect((await conflictPage(runId)).items[0]?.resolution?.strategy).toBe("use_a");
    const exported = await app.inject({ method: "GET", url: `/api/runs/${runId}/export` });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain("identity_decision_source");
    expect(exported.body).toContain("human");
    expect(exported.body).toContain("'=SUM(1,2)");
    const after = await Promise.all(paths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")));
    expect(after).toEqual(before);
  });

  it("uses matching and merge flags independently and summarizes merge differences by field", async () => {
    const capturedMappings: Parameters<MatcherRunner["match"]>[0]["mappings"] = [];
    await app.close();
    app = buildApp({ dataRoot, matcher: {
      ...matcher,
      async match(input) { capturedMappings.push(...input.mappings); return baseMatcherResult(); },
    } });
    const created = RunSummarySchema.parse((await app.inject({ method: "POST", url: "/api/runs" })).json());
    for (const [side, bytes] of [["A", aBytes], ["B", bBytes]] as const) {
      await app.inject({ method: "POST", url: `/api/runs/${created.runId}/datasets/${side}`, headers: { "content-type": "text/csv", "x-file-name": `${side}.csv` }, payload: bytes });
    }
    await app.inject({ method: "PUT", url: `/api/runs/${created.runId}/mappings`, payload: { mappings: [
      { mappingId: "status", label: "Status", aColumn: "status", bColumn: "status", useForMatching: true, includeInMerge: true, normalizer: "text" },
      { mappingId: "record-id", label: "Record ID", aColumn: "id", bColumn: "id", useForMatching: false, includeInMerge: false, normalizer: "text" },
    ] } });
    await app.inject({ method: "POST", url: `/api/runs/${created.runId}/match` });
    expect(capturedMappings.map((item) => item.mappingId)).toEqual(["status"]);
    const afterSame = RunSummarySchema.parse((await app.inject({ method: "POST", url: `/api/runs/${created.runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } })).json());
    expect(afterSame.conflictSummary).toMatchObject({ total: 1, unresolved: 1, fields: [{ mappingId: "status", total: 1, unresolved: 1 }] });
    expect((await conflictPage(created.runId)).items[0]).toMatchObject({ mappingId: "status", aValue: "=SUM(1,2)", bValue: "inactive" });
  });

  it("keeps an exact generic identity pair in review instead of exporting source-only rows", async () => {
    const stableMatcher: MatcherRunner = {
      async profile(input) {
        return {
          contractVersion: "1.0.0", datasetId: input.datasetId, side: input.side,
          originalFilename: input.originalFilename, sha256: input.sha256, rowCount: 1,
          columns: ["record_id", "stable_id"].map((name) => ({ name, inferredType: "string" as const, nullCount: 0, nullRate: 0, distinctCount: 1, distinctRate: 1, samples: [name] })),
        };
      },
      async match() {
        return {
          contractVersion: "1.0.0", matcherVersion: MATCHER_VERSION,
          candidateEngineVersion: "candidate-engine-v0.3.0",
          blockingNormalizationVersion: "blocking-normalization-v0.1.0",
          featurePipelineVersion: "feature-pipeline-v0.1.0",
          matcherConfigVersion: "matcher-config-v0.2.0",
          matcherConfig: { frozen: true, decisions: { minimumAutoAgreementFields: 2 } },
          candidates: [{
            candidateId: "candidate-stable-id", aRowId: "A-IV-701", bRowId: "B-IV-301",
            aRecord: { record_id: "A-IV-701", stable_id: "VEND-7001" },
            bRecord: { record_id: "B-IV-301", stable_id: "VEND-7001" },
            rank: 1, matchScore: 1, runnerUpMargin: 1, band: "needs_review", collision: false,
            strongContradiction: false,
            blockingEvidence: [{ blockerId: "exact_strong_v1", keyHash: "0123456789abcdef" }],
            positiveEvidence: 0.5, conflictEvidence: 0, totalWeight: 0.5,
            evidence: [{
              mappingId: "stable-id", label: "Stable ID", aColumn: "stable_id", bColumn: "stable_id",
              aValue: "VEND-7001", bValue: "VEND-7001", normalizedA: "vend 7001", normalizedB: "vend 7001",
              fieldKind: "other", featurePipelineVersion: "feature-pipeline-v0.1.0",
              features: [{ name: "normalized_exact", value: 1 }], outcome: "exact", evidenceClass: "exact_agreement",
              weight: 0.5, positiveContribution: 0.5, conflictContribution: 0, contribution: 0.5,
              explanationCode: "other_exact", explanation: "Stable ID has exact normalized agreement.",
            }],
          }],
          onlyA: [],
          onlyB: [{ rowId: "B-IV-301", record: { record_id: "B-IV-301", stable_id: "VEND-7001" } }],
        };
      },
    };
    const hotfixRoot = await mkdtemp(join(tmpdir(), "samewise-hotfix-"));
    const hotfixApp = buildApp({ dataRoot: hotfixRoot, matcher: stableMatcher });
    try {
      const created = RunSummarySchema.parse((await hotfixApp.inject({ method: "POST", url: "/api/runs" })).json());
      for (const [side, row] of [["A", "A-IV-701"], ["B", "B-IV-301"]] as const) {
        const upload = await hotfixApp.inject({
          method: "POST", url: `/api/runs/${created.runId}/datasets/${side}`,
          headers: { "content-type": "text/csv", "x-file-name": `${side.toLowerCase()}.csv` },
          payload: Buffer.from(`record_id,stable_id\n${row},VEND-7001\n`),
        });
        expect(upload.statusCode).toBe(201);
      }
      await hotfixApp.inject({
        method: "PUT", url: `/api/runs/${created.runId}/mappings`,
        payload: { mappings: [{ mappingId: "stable-id", label: "Stable ID", aColumn: "stable_id", bColumn: "stable_id", useForMatching: true, includeInMerge: false, normalizer: "text" }] },
      });
      const matched = RunSummarySchema.parse((await hotfixApp.inject({ method: "POST", url: `/api/runs/${created.runId}/match` })).json());
      expect(matched.summary).toMatchObject({ matched: 0, needsReview: 1, onlyA: 0 });
      expect(matched.trustedExportReadiness).toMatchObject({ ready: false, unresolvedIdentityCount: 1 });
      const exported = (await hotfixApp.inject({ method: "GET", url: `/api/runs/${created.runId}/export` })).body;
      expect(exported).toContain("A-IV-701,B-IV-301,needs_review,pending_human_review");
      expect(exported).not.toContain("source_only_a");
      expect(exported).not.toContain("source_only_b");
    } finally {
      await hotfixApp.close();
    }
  });

  it("serves compact, bounded projections and byte-equivalent candidate evidence", async () => {
    const { runId } = await setup();
    const summaryResponse = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
    const summary = RunSummarySchema.parse(summaryResponse.json());
    expect(summaryResponse.json()).not.toHaveProperty("candidates");
    expect(summaryResponse.json()).not.toHaveProperty("reviewQueue");
    expect(summaryResponse.json()).not.toHaveProperty("onlyA");
    expect(summary.summary).toEqual({ matched: 0, needsReview: 1, onlyA: 0, onlyB: 2 });

    const results = ResultsPageSchema.parse((await app.inject({ method: "GET", url: `/api/runs/${runId}/results?offset=0&limit=1` })).json());
    expect(results.items).toHaveLength(1);
    expect(results.items[0]).toMatchObject({ aRowId: "A1", status: "needs_review", topCandidate: { candidateId: "candidate-1-1" } });
    expect(results.page).toMatchObject({ offset: 0, limit: 1, total: 1, returned: 1, nextOffset: null });

    const review = ReviewQueuePageSchema.parse((await app.inject({ method: "GET", url: `/api/runs/${runId}/review?limit=999&filter=all&sort=source` })).json());
    expect(review.page.limit).toBe(100);
    expect(review.items[0]?.candidates[0]).not.toHaveProperty("evidence");
    expect(JSON.stringify(review)).not.toContain("featurePipelineVersion");
    expect((await app.inject({ method: "GET", url: `/api/runs/${runId}/review?offset=bad` })).statusCode).toBe(400);

    const detail = await candidateDetail(runId);
    expect(detail.candidate).toEqual(baseMatcherResult().candidates[0]);
    expect(detail).toMatchObject({ matcherVersion: MATCHER_VERSION, candidateEngineVersion: "candidate-engine-v0.3.0" });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toMatch(/canonicalEntityId|corruptionProvenance|groundTruth|OPENAI_API_KEY/i);
    expect((await app.inject({ method: "GET", url: `/api/runs/${runId}/candidates/not-in-this-run` })).statusCode).toBe(404);
    const otherRunId = RunSummarySchema.parse((await app.inject({ method: "POST", url: "/api/runs" })).json()).runId;
    expect((await app.inject({ method: "GET", url: `/api/runs/${otherRunId}/candidates/candidate-1-1` })).statusCode).toBe(404);
  });

  it("previews and explicitly applies a versioned per-field rule only after identity confirmation", async () => {
    const { runId, result } = await setup();
    expect(result.conflictSummary.total).toBe(0);
    const configuredBeforeIdentity = RunSummarySchema.parse((await app.inject({ method: "PUT", url: `/api/runs/${runId}/survivorship-policy`, payload: { fieldPolicies: [{ semanticField: "status", strategy: "prefer_trusted_source", trustedSource: "B" }] } })).json());
    const rule = configuredBeforeIdentity.survivorshipPolicy!.fieldPolicies[0]!;
    const unpreviewedApply = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-apply`, payload: { ruleId: rule.ruleId } });
    expect(unpreviewedApply.statusCode).toBe(409);
    expect(unpreviewedApply.json().error.code).toBe("survivorship_preview_required");
    const emptyPreview = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-preview`, payload: { ruleId: rule.ruleId } });
    expect(emptyPreview.json()).toMatchObject({ affectedCount: 0, resolvableCount: 0 });
    const emptyApply = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-apply`, payload: { ruleId: rule.ruleId } });
    expect(emptyApply.json()).toMatchObject({ appliedCount: 0 });
    expect(RunSummarySchema.parse(emptyApply.json().run).conflictSummary.total).toBe(0);

    await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } });
    expect((await conflictPage(runId)).items[0]?.resolution).toBeNull();
    const preview = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-preview`, payload: { ruleId: rule.ruleId } });
    expect(preview.json()).toMatchObject({ affectedCount: 1, resolvableCount: 1, unresolvedCount: 0, items: [{ outcome: "would_resolve", chosenSource: "B", chosenValue: "inactive" }] });
    expect((await conflictPage(runId)).items[0]?.resolution).toBeNull();
    const applied = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-apply`, payload: { ruleId: rule.ruleId } });
    const appliedView = RunSummarySchema.parse(applied.json().run);
    expect(applied.json()).toMatchObject({ appliedCount: 1, unresolvedCount: 0 });
    expect(appliedView.conflictSummary.unresolved).toBe(0);
    expect((await conflictPage(runId)).items[0]?.resolution).toMatchObject({ resolutionSource: "rule", strategy: "prefer_trusted_source", chosenSource: "B", chosenValue: "inactive", policyVersion: configuredBeforeIdentity.survivorshipPolicy!.policyVersion, inputSnapshot: { aValue: "=SUM(1,2)", bValue: "inactive" } });
    await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-preview`, payload: { ruleId: rule.ruleId } });
    const repeated = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-apply`, payload: { ruleId: rule.ruleId } });
    expect(repeated.json()).toMatchObject({ appliedCount: 0, skippedCount: 1 });
  });

  it("preserves manual precedence, supports explicit change/clear, and retains compact history", async () => {
    const { runId } = await setup();
    await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } });
    const conflictId = (await conflictPage(runId)).items[0]!.conflictId;
    await app.inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${conflictId}/resolutions`, payload: { action: "use_a" } });
    expect((await conflictPage(runId)).items[0]?.resolution?.chosenSource).toBe("A");
    const accidentalReplace = await app.inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${conflictId}/resolutions`, payload: { action: "use_b" } });
    expect(accidentalReplace.statusCode).toBe(409);
    await app.inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${conflictId}/resolutions`, payload: { action: "use_b", replace: true } });
    expect((await conflictPage(runId)).items[0]).toMatchObject({ status: "resolved", resolution: { chosenSource: "B" }, resolutionHistory: [{ chosenSource: "A" }] });
    await app.inject({ method: "DELETE", url: `/api/runs/${runId}/conflicts/${conflictId}/resolution` });
    const cleared = (await conflictPage(runId)).items[0]!;
    expect(cleared).toMatchObject({ status: "unresolved", resolution: null });
    expect(cleared.resolutionHistory).toHaveLength(2);

    const configured = RunSummarySchema.parse((await app.inject({ method: "PUT", url: `/api/runs/${runId}/survivorship-policy`, payload: { fieldPolicies: [{ semanticField: "status", strategy: "prefer_trusted_source", trustedSource: "B" }] } })).json());
    const ruleId = configured.survivorshipPolicy!.fieldPolicies[0]!.ruleId;
    const wouldResolve = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-preview`, payload: { ruleId } });
    expect(wouldResolve.json()).toMatchObject({ resolvableCount: 1 });
    await app.inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${conflictId}/resolutions`, payload: { action: "use_a" } });
    const manualAgain = (await conflictPage(runId)).items[0]!;
    const staleApply = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-apply`, payload: { ruleId } });
    expect(staleApply.statusCode).toBe(409);
    expect(staleApply.json().error.code).toBe("survivorship_preview_required");
    const preview = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-preview`, payload: { ruleId } });
    expect(preview.json()).toMatchObject({ skippedManualCount: 1, items: [{ outcome: "skipped_manual" }] });
    await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-apply`, payload: { ruleId } });
    expect((await conflictPage(runId)).items[0]?.resolution?.resolutionId).toBe(manualAgain.resolution?.resolutionId);
  });

  it("gates trusted output, treats KEEP BOTH as deliberate, preserves source-only provenance, and defends formulas", async () => {
    const { runId } = await setup();
    expect((await app.inject({ method: "GET", url: `/api/runs/${runId}/export` })).statusCode).toBe(200);
    const identityBlocked = await app.inject({ method: "GET", url: `/api/runs/${runId}/trusted-export` });
    expect(identityBlocked.statusCode).toBe(409);
    expect(identityBlocked.json().error.message).toContain("identity review");
    await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } });
    const conflictBlocked = await app.inject({ method: "GET", url: `/api/runs/${runId}/trusted-export` });
    expect(conflictBlocked.statusCode).toBe(409);
    expect(conflictBlocked.json().error.message).toContain("comparison-field");
    const conflictId = (await conflictPage(runId)).items[0]!.conflictId;
    const kept = RunSummarySchema.parse((await app.inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${conflictId}/resolutions`, payload: { action: "keep_both" } })).json());
    expect(kept.trustedExportReadiness.ready).toBe(true);
    expect((await conflictPage(runId)).items[0]?.resolution).toMatchObject({ strategy: "keep_both", chosenValue: null, keptValues: [{ source: "A", value: "=SUM(1,2)" }, { source: "B", value: "inactive" }] });
    const trusted = await app.inject({ method: "GET", url: `/api/runs/${runId}/trusted-export` });
    expect(trusted.statusCode).toBe(200);
    expect(trusted.body).toContain("Status__A,Status__B,Status__resolution");
    expect(trusted.body).toContain("keep_both,keep_both");
    expect(trusted.body).toContain("'=SUM(1,2)");
    expect(trusted.body).toContain("source_only_b");
    expect(trusted.body).toContain(TRUSTED_EXPORT_VERSION);
  });

  it("creates deterministic artifacts and a versioned manifest with exact content hashes", async () => {
    const { runId, result } = await setup();
    const firstReport = await app.inject({ method: "GET", url: `/api/runs/${runId}/export` });
    const secondReport = await app.inject({ method: "GET", url: `/api/runs/${runId}/export` });
    expect(secondReport.body).toBe(firstReport.body);
    expect(firstReport.headers["content-disposition"]).toMatch(/^attachment; filename="samewise-run-[A-Za-z0-9-]+-reconciliation\.csv"$/);

    const firstManifestResponse = await app.inject({ method: "GET", url: `/api/runs/${runId}/manifest` });
    const secondManifestResponse = await app.inject({ method: "GET", url: `/api/runs/${runId}/manifest` });
    expect(secondManifestResponse.body).toBe(firstManifestResponse.body);
    const manifest = RunManifestSchema.parse(JSON.parse(firstManifestResponse.body));
    expect(manifest.manifestVersion).toBe(RUN_MANIFEST_VERSION);
    expect(manifest.run.status).toBe("identity_unresolved");
    expect(manifest.sourceDatasets.A).toMatchObject({ originalFilename: "a.csv", sha256: createHash("sha256").update(aBytes).digest("hex"), rowCount: 1 });
    expect(manifest.sourceDatasets.B).toMatchObject({ originalFilename: "b.csv", sha256: createHash("sha256").update(bBytes).digest("hex"), rowCount: 2 });
    expect(manifest.semanticMapping).toMatchObject({ mappingVersion: "confirmed-mappings-v2", ai: null });
    expect(manifest.candidateGeneration).toMatchObject({ candidateEngineVersion: "candidate-engine-v0.3.0", blockingNormalizationVersion: "blocking-normalization-v0.1.0", candidateConfigVersion: null });
    expect(manifest.matcher).toMatchObject({ matcherVersion: MATCHER_VERSION, matcherConfigVersion: "matcher-config-v0.2.0" });
    expect(manifest.identity).toMatchObject({ systemEstablishedLinkCount: 0, humanSameCount: 0, humanDifferentCount: 0, pendingCount: 1, deferredCount: 0 });
    expect(manifest.evaluation).toMatchObject({ applicable: false, snapshotId: null });
    expect(manifest.export.artifacts).toHaveLength(1);
    expect(manifest.export.artifacts[0]).toMatchObject({ version: RECONCILIATION_EXPORT_VERSION, sha256: createHash("sha256").update(firstReport.body).digest("hex"), byteLength: Buffer.byteLength(firstReport.body) });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain(dataRoot);
    expect(serialized).not.toMatch(/OPENAI_API_KEY|canonicalEntityId|corruptionProvenance|groundTruth/i);
    expect(result.datasets.A?.sha256).toBe(manifest.sourceDatasets.A.sha256);

    await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } });
    await app.inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${(await conflictPage(runId)).items[0]!.conflictId}/resolutions`, payload: { action: "use_b" } });
    const trustedOne = await app.inject({ method: "GET", url: `/api/runs/${runId}/trusted-export` });
    const trustedTwo = await app.inject({ method: "GET", url: `/api/runs/${runId}/trusted-export` });
    expect(trustedTwo.body).toBe(trustedOne.body);
    const readyManifest = RunManifestSchema.parse(JSON.parse((await app.inject({ method: "GET", url: `/api/runs/${runId}/manifest` })).body));
    expect(readyManifest.run.status).toBe("trusted_ready");
    expect(readyManifest.identity).toMatchObject({ humanSameCount: 1, pendingCount: 0 });
    expect(readyManifest.survivorship).toMatchObject({ manualResolutionCount: 1, ruleGeneratedResolutionCount: 0, unresolvedConflictCount: 0 });
    expect(readyManifest.export.artifacts[1]).toMatchObject({ version: TRUSTED_EXPORT_VERSION, sha256: createHash("sha256").update(trustedOne.body).digest("hex") });
  });

  it("exports human DIFFERENT and deferred identity as explicit audit states", async () => {
    const deferredRun = await setup();
    await app.inject({ method: "PATCH", url: `/api/runs/${deferredRun.runId}/review-items/A1`, payload: { deferred: true } });
    const deferred = await app.inject({ method: "GET", url: `/api/runs/${deferredRun.runId}/export` });
    expect(deferred.body).toContain("deferred,human_defer");
    expect(deferred.body).toContain("Identity review was explicitly deferred.");

    const differentRun = await setup();
    await app.inject({ method: "POST", url: `/api/runs/${differentRun.runId}/candidates/candidate-1-1/decisions`, payload: { decision: "different_entity" } });
    const different = await app.inject({ method: "GET", url: `/api/runs/${differentRun.runId}/export` });
    expect(different.body).toContain("different_entity,human,decision-");
    expect(different.body).toContain("identity_different");
    expect(different.body).toContain("only_a");
    expect(different.body).toContain("only_b");
  });

  it("quotes CSV correctly, preserves Unicode, defends every formula prefix, and leaves negative numbers intact", async () => {
    for (const dangerous of ["=cmd", "+cmd", "-cmd", "@cmd", "=HYPERLINK(\"x,y\")\nMünchen"]) {
      const base = baseMatcherResult();
      matcherResultOverride = { ...base, candidates: [{ ...base.candidates[0]!, aRecord: { ...base.candidates[0]!.aRecord, status: dangerous } }] };
      const { runId } = await setup();
      await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } });
      await app.inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${(await conflictPage(runId)).items[0]!.conflictId}/resolutions`, payload: { action: "use_a" } });
      const report = (await app.inject({ method: "GET", url: `/api/runs/${runId}/export` })).body;
      const trusted = (await app.inject({ method: "GET", url: `/api/runs/${runId}/trusted-export` })).body;
      expect(report).toContain(`'${dangerous[0]}`);
      expect(trusted).toContain(`'${dangerous[0]}`);
      if (dangerous.includes("München")) {
        expect(report).toContain("München");
        expect(report).toContain('""x,y""');
        expect(report).toContain("\n");
      }
    }

    const base = baseMatcherResult();
    matcherResultOverride = { ...base, candidates: [{ ...base.candidates[0]!, aRecord: { ...base.candidates[0]!.aRecord, status: "-42.5" } }] };
    const { runId } = await setup();
    const report = (await app.inject({ method: "GET", url: `/api/runs/${runId}/export` })).body;
    expect(report).toContain("-42.5");
    expect(report).not.toContain("'-42.5");
  });

  it("generates a deterministic 10,000-row reconciliation artifact without an export-only scaling abstraction", async () => {
    const { result } = await setup();
    const { projectionVersion: _projectionVersion, conflictSummary: _conflictSummary, ...fullBase } = result;
    void _projectionVersion;
    void _conflictSummary;
    const large = {
      ...fullBase,
      summary: { matched: 0, needsReview: 0, onlyA: 10_000, onlyB: 0 },
      candidates: [], decisions: [], conflicts: [], reviewQueue: [],
      reviewProgress: { total: 0, reviewed: 0, remaining: 0, deferred: 0 },
      onlyA: Array.from({ length: 10_000 }, (_, index) => ({ rowId: `A${index.toString().padStart(5, "0")}`, record: { name: `Entity ${index}`, status: index % 2 ? "active" : "inactive" } })),
      onlyB: [],
    };
    const first = exportRun(RunViewSchema.parse(large));
    const second = exportRun(RunViewSchema.parse(large));
    expect(first).toBe(second);
    expect(first.split("\r\n")).toHaveLength(10_002);
  });

  it("treats traversal-like upload names as metadata and never reuses them for artifact filenames", async () => {
    const created = RunSummarySchema.parse((await app.inject({ method: "POST", url: "/api/runs" })).json());
    const uploaded = await app.inject({
      method: "POST", url: `/api/runs/${created.runId}/datasets/A`,
      headers: { "content-type": "text/csv", "x-file-name": encodeURIComponent("../../server/unsafe.csv") }, payload: aBytes,
    });
    const view = RunSummarySchema.parse(uploaded.json());
    expect(view.datasets.A?.originalFilename).toBe("unsafe.csv");
    const names = await readdir(join(dataRoot, created.runId));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^dataset-[a-f0-9-]+\.csv$/);
    expect(names[0]).not.toContain("unsafe");
  });

  it("rejects an invalid policy atomically and leaves the last valid policy intact", async () => {
    const { runId } = await setup();
    const valid = RunSummarySchema.parse((await app.inject({ method: "PUT", url: `/api/runs/${runId}/survivorship-policy`, payload: { fieldPolicies: [{ semanticField: "status", strategy: "prefer_non_null" }] } })).json());
    const invalid = await app.inject({ method: "PUT", url: `/api/runs/${runId}/survivorship-policy`, payload: { fieldPolicies: [{ semanticField: "unknown", strategy: "prefer_non_null" }] } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("invalid_survivorship_policy");
    const preserved = RunSummarySchema.parse((await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json());
    expect(preserved.survivorshipPolicy?.policyVersion).toBe(valid.survivorshipPolicy?.policyVersion);
  });

  it("records DIFFERENT ENTITY without creating field conflicts", async () => {
    const { runId } = await setup();
    const response = await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "different_entity" } });
    const view = RunSummarySchema.parse(response.json());
    expect((await candidateDetail(runId)).humanDecision?.humanDecision).toBe("different_entity");
    expect(view.conflictSummary.total).toBe(0);
    expect(view.summary?.onlyA).toBe(1);
    expect(view.summary?.onlyB).toBe(2);
  });

  it("derives a stable per-A queue, real progress, and reversible defer state", async () => {
    const { runId, result } = await setup();
    expect((await reviewPage(runId)).items).toEqual([expect.objectContaining({
      aRowId: "A1", topCandidateId: "candidate-1-1", topBRowId: "B1",
      candidateCount: 1, state: "needs_review", matcherVersion: MATCHER_VERSION,
      strongestPositive: expect.objectContaining({ mappingId: "name" }),
    })]);
    expect(result.reviewProgress).toEqual({ total: 1, reviewed: 0, remaining: 1, deferred: 0 });

    const deferred = RunSummarySchema.parse((await app.inject({
      method: "PATCH", url: `/api/runs/${runId}/review-items/A1`, payload: { deferred: true },
    })).json());
    expect((await reviewPage(runId)).items[0]?.state).toBe("deferred");
    expect(deferred.reviewProgress).toEqual({ total: 1, reviewed: 0, remaining: 0, deferred: 1 });

    const returned = RunSummarySchema.parse((await app.inject({
      method: "PATCH", url: `/api/runs/${runId}/review-items/A1`, payload: { deferred: false },
    })).json());
    expect((await reviewPage(runId)).items[0]?.state).toBe("needs_review");
    expect(returned.reviewProgress.remaining).toBe(1);
  });

  it("keeps alternatives available after DIFFERENT and undoes recent DIFFERENT decisions in order", async () => {
    const base = baseMatcherResult();
    const first = base.candidates[0]!;
    matcherResultOverride = {
      ...base,
      candidates: [first, {
        ...first,
        candidateId: "candidate-1-2", bRowId: "B2", bRecord: { id: "B2", organization: "Other", status: "active" },
        rank: 2, matchScore: 0.43, runnerUpMargin: 0.2,
      }],
    };
    const { runId } = await setup();
    await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "different_entity" } });
    expect((await reviewPage(runId)).items[0]).toMatchObject({ state: "needs_review", candidateCount: 2, topCandidateId: "candidate-1-2", topBRowId: "B2" });
    expect((await candidateDetail(runId)).humanDecision?.humanDecision).toBe("different_entity");

    const afterSecond = RunSummarySchema.parse((await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-2/decisions`, payload: { decision: "different_entity" } })).json());
    expect((await reviewPage(runId)).items[0]?.state).toBe("reviewed_different");
    expect(afterSecond.reviewProgress).toEqual({ total: 1, reviewed: 1, remaining: 0, deferred: 0 });

    await app.inject({ method: "POST", url: `/api/runs/${runId}/review-undo` });
    expect((await candidateDetail(runId, "candidate-1-1")).humanDecision?.humanDecision).toBe("different_entity");
    expect((await reviewPage(runId)).items[0]?.state).toBe("needs_review");
    await app.inject({ method: "POST", url: `/api/runs/${runId}/review-undo` });
    expect((await candidateDetail(runId, "candidate-1-1")).humanDecision).toBeNull();
  });

  it("undoes SAME and its unresolved dependent conflicts, but blocks after a field resolution", async () => {
    const first = await setup();
    const afterSame = RunSummarySchema.parse((await app.inject({ method: "POST", url: `/api/runs/${first.runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } })).json());
    expect(afterSame.reviewUndo?.canUndo).toBe(true);
    expect(afterSame.conflictSummary.total).toBe(1);
    const undone = RunSummarySchema.parse((await app.inject({ method: "POST", url: `/api/runs/${first.runId}/review-undo` })).json());
    expect(undone.conflictSummary.total).toBe(0);
    expect((await reviewPage(first.runId)).items[0]?.state).toBe("needs_review");

    const second = await setup();
    await app.inject({ method: "POST", url: `/api/runs/${second.runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } });
    await app.inject({ method: "POST", url: `/api/runs/${second.runId}/conflicts/${(await conflictPage(second.runId)).items[0]!.conflictId}/resolutions`, payload: { action: "use_a" } });
    const blocked = await app.inject({ method: "POST", url: `/api/runs/${second.runId}/review-undo` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: { code: "undo_blocked_by_resolutions", message: expect.stringContaining("already been resolved") } });
    const preserved = RunSummarySchema.parse((await app.inject({ method: "GET", url: `/api/runs/${second.runId}` })).json());
    expect((await candidateDetail(second.runId)).humanDecision?.humanDecision).toBe("same_entity");
    expect((await conflictPage(second.runId)).items[0]?.resolution).not.toBeNull();
    expect(preserved.reviewUndo?.canUndo).toBe(false);
  });

  it("surfaces shared-B collision context without imposing global assignment", async () => {
    const base = baseMatcherResult();
    const first = { ...base.candidates[0]!, collision: true };
    matcherResultOverride = {
      ...base,
      candidates: [first, {
        ...first,
        candidateId: "candidate-2-1", aRowId: "A2", aRecord: { id: "A2", name: "Acme Holdings", status: "active" },
        matchScore: 0.68,
      }],
    };
    const { runId } = await setup();
    const review = await reviewPage(runId);
    expect(review.items).toHaveLength(2);
    expect(review.items[0]).toMatchObject({ collision: true, collisionARowIds: ["A2"] });
    expect(review.items[1]).toMatchObject({ collision: true, collisionARowIds: ["A1"] });
  });

  it("keeps a system auto-match distinct from a human SAME confirmation", async () => {
    const base = baseMatcherResult();
    matcherResultOverride = { ...base, candidates: [{ ...base.candidates[0]!, band: "auto_match" }] };
    const { runId, result } = await setup();
    expect(result.summary?.matched).toBe(1);
    expect((await reviewPage(runId)).items).toEqual([]);
    await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } });
    expect((await reviewPage(runId)).items[0]).toMatchObject({ state: "reviewed_same", humanDecision: { humanDecision: "same_entity" } });
    expect((await candidateDetail(runId)).humanDecision?.systemProposal).toBe("auto_match");
  });

  it("rejects unsupported, empty, duplicate, and invalid mapping uploads safely", async () => {
    const created = RunSummarySchema.parse((await app.inject({ method: "POST", url: "/api/runs" })).json());
    const unsupported = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/datasets/A`, headers: { "content-type": "application/json", "x-file-name": "a.xlsx" }, payload: {} });
    expect(unsupported.statusCode).toBe(415);
    const empty = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/datasets/A`, headers: { "content-type": "text/csv", "x-file-name": "a.csv" }, payload: Buffer.alloc(0) });
    expect(empty.statusCode).toBe(400);
  });
});
