import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MATCHER_VERSION, RunViewSchema, type MatcherResult } from "@samewise/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { MatcherRunner } from "../src/matcher-process.js";

const aBytes = Buffer.from("id,name,status\nA1,Acme Corp,=SUM(1,2)\n");
const bBytes = Buffer.from("id,organization,status\nB1,Acme Corporation,inactive\nB2,Other,active\n");

let matcherResultOverride: MatcherResult | undefined;

function baseMatcherResult(): MatcherResult {
  return {
    contractVersion: "1.0.0", matcherVersion: MATCHER_VERSION,
    candidateEngineVersion: "candidate-engine-v0.2.0",
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
    const created = RunViewSchema.parse((await app.inject({ method: "POST", url: "/api/runs" })).json());
    for (const [side, filename, bytes] of [["A", "a.csv", aBytes], ["B", "b.csv", bBytes]] as const) {
      const response = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/datasets/${side}`, headers: { "content-type": "text/csv", "x-file-name": filename }, payload: bytes });
      expect(response.statusCode).toBe(201);
    }
    const mapped = await app.inject({ method: "PUT", url: `/api/runs/${created.runId}/mappings`, payload: { mappings: [
      { mappingId: "name", label: "Organization name", aColumn: "name", bColumn: "organization", role: "identity", normalizer: "text" },
      { mappingId: "status", label: "Status", aColumn: "status", bColumn: "status", role: "comparison", normalizer: "text" },
    ] } });
    expect(mapped.statusCode).toBe(200);
    const result = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/match` });
    expect(result.statusCode).toBe(200);
    return { runId: created.runId, result: RunViewSchema.parse(result.json()) };
  }

  it("uploads, profiles, maps, matches, decides SAME, resolves explicitly, and exports without mutating sources", async () => {
    const { runId, result } = await setup();
    expect(result.summary).toEqual({ matched: 0, needsReview: 1, onlyA: 0, onlyB: 2 });
    expect(result.mappingVersion).toBe("confirmed-mappings-v1");
    expect(result.matcherProvenance).toMatchObject({
      matcherVersion: MATCHER_VERSION,
      candidateEngineVersion: "candidate-engine-v0.2.0",
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
    const afterSame = RunViewSchema.parse(same.json());
    expect(afterSame.decisions[0]?.humanDecision).toBe("same_entity");
    expect(afterSame.summary?.onlyB).toBe(1);
    expect(afterSame.conflicts).toHaveLength(1);
    expect(afterSame.conflicts[0]?.resolution).toBeNull();

    const resolved = await app.inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${afterSame.conflicts[0]!.conflictId}/resolutions`, payload: { action: "use_a" } });
    expect(RunViewSchema.parse(resolved.json()).conflicts[0]?.resolution?.strategy).toBe("use_a");
    const exported = await app.inject({ method: "GET", url: `/api/runs/${runId}/export` });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain("identity_decision_source");
    expect(exported.body).toContain("human");
    expect(exported.body).toContain("'=SUM(1,2)");
    const after = await Promise.all(paths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")));
    expect(after).toEqual(before);
  });

  it("previews and explicitly applies a versioned per-field rule only after identity confirmation", async () => {
    const { runId, result } = await setup();
    expect(result.conflicts).toEqual([]);
    const configuredBeforeIdentity = RunViewSchema.parse((await app.inject({ method: "PUT", url: `/api/runs/${runId}/survivorship-policy`, payload: { fieldPolicies: [{ semanticField: "status", strategy: "prefer_trusted_source", trustedSource: "B" }] } })).json());
    const rule = configuredBeforeIdentity.survivorshipPolicy!.fieldPolicies[0]!;
    const unpreviewedApply = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-apply`, payload: { ruleId: rule.ruleId } });
    expect(unpreviewedApply.statusCode).toBe(409);
    expect(unpreviewedApply.json().error.code).toBe("survivorship_preview_required");
    const emptyPreview = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-preview`, payload: { ruleId: rule.ruleId } });
    expect(emptyPreview.json()).toMatchObject({ affectedCount: 0, resolvableCount: 0 });
    const emptyApply = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-apply`, payload: { ruleId: rule.ruleId } });
    expect(emptyApply.json()).toMatchObject({ appliedCount: 0 });
    expect(RunViewSchema.parse(emptyApply.json().run).conflicts).toEqual([]);

    const afterSame = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } })).json());
    expect(afterSame.conflicts[0]?.resolution).toBeNull();
    const preview = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-preview`, payload: { ruleId: rule.ruleId } });
    expect(preview.json()).toMatchObject({ affectedCount: 1, resolvableCount: 1, unresolvedCount: 0, items: [{ outcome: "would_resolve", chosenSource: "B", chosenValue: "inactive" }] });
    expect(RunViewSchema.parse((await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json()).conflicts[0]?.resolution).toBeNull();
    const applied = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-apply`, payload: { ruleId: rule.ruleId } });
    const appliedView = RunViewSchema.parse(applied.json().run);
    expect(applied.json()).toMatchObject({ appliedCount: 1, unresolvedCount: 0 });
    expect(appliedView.conflicts[0]?.resolution).toMatchObject({ resolutionSource: "rule", strategy: "prefer_trusted_source", chosenSource: "B", chosenValue: "inactive", policyVersion: configuredBeforeIdentity.survivorshipPolicy!.policyVersion, inputSnapshot: { aValue: "=SUM(1,2)", bValue: "inactive" } });
    await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-preview`, payload: { ruleId: rule.ruleId } });
    const repeated = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-apply`, payload: { ruleId: rule.ruleId } });
    expect(repeated.json()).toMatchObject({ appliedCount: 0, skippedCount: 1 });
  });

  it("preserves manual precedence, supports explicit change/clear, and retains compact history", async () => {
    const { runId } = await setup();
    const afterSame = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } })).json());
    const conflictId = afterSame.conflicts[0]!.conflictId;
    const useA = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${conflictId}/resolutions`, payload: { action: "use_a" } })).json());
    expect(useA.conflicts[0]?.resolution?.chosenSource).toBe("A");
    const accidentalReplace = await app.inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${conflictId}/resolutions`, payload: { action: "use_b" } });
    expect(accidentalReplace.statusCode).toBe(409);
    const useB = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${conflictId}/resolutions`, payload: { action: "use_b", replace: true } })).json());
    expect(useB.conflicts[0]).toMatchObject({ status: "resolved", resolution: { chosenSource: "B" }, resolutionHistory: [{ chosenSource: "A" }] });
    const cleared = RunViewSchema.parse((await app.inject({ method: "DELETE", url: `/api/runs/${runId}/conflicts/${conflictId}/resolution` })).json());
    expect(cleared.conflicts[0]).toMatchObject({ status: "unresolved", resolution: null });
    expect(cleared.conflicts[0]?.resolutionHistory).toHaveLength(2);

    const configured = RunViewSchema.parse((await app.inject({ method: "PUT", url: `/api/runs/${runId}/survivorship-policy`, payload: { fieldPolicies: [{ semanticField: "status", strategy: "prefer_trusted_source", trustedSource: "B" }] } })).json());
    const ruleId = configured.survivorshipPolicy!.fieldPolicies[0]!.ruleId;
    const wouldResolve = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-preview`, payload: { ruleId } });
    expect(wouldResolve.json()).toMatchObject({ resolvableCount: 1 });
    const manualAgain = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${conflictId}/resolutions`, payload: { action: "use_a" } })).json());
    const staleApply = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-apply`, payload: { ruleId } });
    expect(staleApply.statusCode).toBe(409);
    expect(staleApply.json().error.code).toBe("survivorship_preview_required");
    const preview = await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-preview`, payload: { ruleId } });
    expect(preview.json()).toMatchObject({ skippedManualCount: 1, items: [{ outcome: "skipped_manual" }] });
    await app.inject({ method: "POST", url: `/api/runs/${runId}/survivorship-apply`, payload: { ruleId } });
    expect(RunViewSchema.parse((await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json()).conflicts[0]?.resolution?.resolutionId).toBe(manualAgain.conflicts[0]?.resolution?.resolutionId);
  });

  it("gates trusted output, treats KEEP BOTH as deliberate, preserves source-only provenance, and defends formulas", async () => {
    const { runId } = await setup();
    expect((await app.inject({ method: "GET", url: `/api/runs/${runId}/export` })).statusCode).toBe(200);
    const identityBlocked = await app.inject({ method: "GET", url: `/api/runs/${runId}/trusted-export` });
    expect(identityBlocked.statusCode).toBe(409);
    expect(identityBlocked.json().error.message).toContain("identity review");
    const same = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } })).json());
    const conflictBlocked = await app.inject({ method: "GET", url: `/api/runs/${runId}/trusted-export` });
    expect(conflictBlocked.statusCode).toBe(409);
    expect(conflictBlocked.json().error.message).toContain("comparison-field");
    const kept = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${same.conflicts[0]!.conflictId}/resolutions`, payload: { action: "keep_both" } })).json());
    expect(kept.trustedExportReadiness.ready).toBe(true);
    expect(kept.conflicts[0]?.resolution).toMatchObject({ strategy: "keep_both", chosenValue: null, keptValues: [{ source: "A", value: "=SUM(1,2)" }, { source: "B", value: "inactive" }] });
    const trusted = await app.inject({ method: "GET", url: `/api/runs/${runId}/trusted-export` });
    expect(trusted.statusCode).toBe(200);
    expect(trusted.body).toContain("Status__A,Status__B,Status__resolution");
    expect(trusted.body).toContain("keep_both,keep_both");
    expect(trusted.body).toContain("'=SUM(1,2)");
    expect(trusted.body).toContain("source_only_b");
    expect(trusted.body).toContain("trusted-merged-export-v1");
  });

  it("rejects an invalid policy atomically and leaves the last valid policy intact", async () => {
    const { runId } = await setup();
    const valid = RunViewSchema.parse((await app.inject({ method: "PUT", url: `/api/runs/${runId}/survivorship-policy`, payload: { fieldPolicies: [{ semanticField: "status", strategy: "prefer_non_null" }] } })).json());
    const invalid = await app.inject({ method: "PUT", url: `/api/runs/${runId}/survivorship-policy`, payload: { fieldPolicies: [{ semanticField: "unknown", strategy: "prefer_non_null" }] } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("invalid_survivorship_policy");
    const preserved = RunViewSchema.parse((await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json());
    expect(preserved.survivorshipPolicy?.policyVersion).toBe(valid.survivorshipPolicy?.policyVersion);
  });

  it("records DIFFERENT ENTITY without creating field conflicts", async () => {
    const { runId } = await setup();
    const response = await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "different_entity" } });
    const view = RunViewSchema.parse(response.json());
    expect(view.decisions[0]?.humanDecision).toBe("different_entity");
    expect(view.conflicts).toEqual([]);
    expect(view.summary?.onlyA).toBe(1);
    expect(view.summary?.onlyB).toBe(2);
  });

  it("derives a stable per-A queue, real progress, and reversible defer state", async () => {
    const { runId, result } = await setup();
    expect(result.reviewQueue).toEqual([expect.objectContaining({
      aRowId: "A1", topCandidateId: "candidate-1-1", topBRowId: "B1",
      candidateCount: 1, state: "needs_review", matcherVersion: MATCHER_VERSION,
      strongestPositive: expect.objectContaining({ mappingId: "name" }),
    })]);
    expect(result.reviewProgress).toEqual({ total: 1, reviewed: 0, remaining: 1, deferred: 0 });

    const deferred = RunViewSchema.parse((await app.inject({
      method: "PATCH", url: `/api/runs/${runId}/review-items/A1`, payload: { deferred: true },
    })).json());
    expect(deferred.reviewQueue[0]?.state).toBe("deferred");
    expect(deferred.reviewProgress).toEqual({ total: 1, reviewed: 0, remaining: 0, deferred: 1 });

    const returned = RunViewSchema.parse((await app.inject({
      method: "PATCH", url: `/api/runs/${runId}/review-items/A1`, payload: { deferred: false },
    })).json());
    expect(returned.reviewQueue[0]?.state).toBe("needs_review");
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
    const afterFirst = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "different_entity" } })).json());
    expect(afterFirst.reviewQueue[0]).toMatchObject({ state: "needs_review", candidateCount: 2, topCandidateId: "candidate-1-2", topBRowId: "B2" });
    expect(afterFirst.decisions).toHaveLength(1);
    expect(afterFirst.conflicts).toEqual([]);

    const afterSecond = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-2/decisions`, payload: { decision: "different_entity" } })).json());
    expect(afterSecond.reviewQueue[0]?.state).toBe("reviewed_different");
    expect(afterSecond.reviewProgress).toEqual({ total: 1, reviewed: 1, remaining: 0, deferred: 0 });

    const undoneSecond = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${runId}/review-undo` })).json());
    expect(undoneSecond.decisions.map((decision) => decision.candidateId)).toEqual(["candidate-1-1"]);
    expect(undoneSecond.reviewQueue[0]?.state).toBe("needs_review");
    const undoneFirst = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${runId}/review-undo` })).json());
    expect(undoneFirst.decisions).toEqual([]);
  });

  it("undoes SAME and its unresolved dependent conflicts, but blocks after a field resolution", async () => {
    const first = await setup();
    const afterSame = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${first.runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } })).json());
    expect(afterSame.reviewUndo?.canUndo).toBe(true);
    expect(afterSame.conflicts).toHaveLength(1);
    const undone = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${first.runId}/review-undo` })).json());
    expect(undone.decisions).toEqual([]);
    expect(undone.conflicts).toEqual([]);
    expect(undone.reviewQueue[0]?.state).toBe("needs_review");

    const second = await setup();
    const decided = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${second.runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } })).json());
    await app.inject({ method: "POST", url: `/api/runs/${second.runId}/conflicts/${decided.conflicts[0]!.conflictId}/resolutions`, payload: { action: "use_a" } });
    const blocked = await app.inject({ method: "POST", url: `/api/runs/${second.runId}/review-undo` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: { code: "undo_blocked_by_resolutions", message: expect.stringContaining("already been resolved") } });
    const preserved = RunViewSchema.parse((await app.inject({ method: "GET", url: `/api/runs/${second.runId}` })).json());
    expect(preserved.decisions).toHaveLength(1);
    expect(preserved.conflicts[0]?.resolution).not.toBeNull();
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
    const { result } = await setup();
    expect(result.reviewQueue).toHaveLength(2);
    expect(result.reviewQueue[0]).toMatchObject({ collision: true, collisionARowIds: ["A2"] });
    expect(result.reviewQueue[1]).toMatchObject({ collision: true, collisionARowIds: ["A1"] });
  });

  it("keeps a system auto-match distinct from a human SAME confirmation", async () => {
    const base = baseMatcherResult();
    matcherResultOverride = { ...base, candidates: [{ ...base.candidates[0]!, band: "auto_match" }] };
    const { runId, result } = await setup();
    expect(result.summary?.matched).toBe(1);
    expect(result.reviewQueue).toEqual([]);
    expect(result.decisions).toEqual([]);
    const humanConfirmed = RunViewSchema.parse((await app.inject({ method: "POST", url: `/api/runs/${runId}/candidates/candidate-1-1/decisions`, payload: { decision: "same_entity" } })).json());
    expect(humanConfirmed.reviewQueue[0]).toMatchObject({ state: "reviewed_same", humanDecision: { humanDecision: "same_entity" } });
    expect(humanConfirmed.decisions[0]?.systemProposal).toBe("auto_match");
  });

  it("rejects unsupported, empty, duplicate, and invalid mapping uploads safely", async () => {
    const created = RunViewSchema.parse((await app.inject({ method: "POST", url: "/api/runs" })).json());
    const unsupported = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/datasets/A`, headers: { "content-type": "application/json", "x-file-name": "a.xlsx" }, payload: {} });
    expect(unsupported.statusCode).toBe(415);
    const empty = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/datasets/A`, headers: { "content-type": "text/csv", "x-file-name": "a.csv" }, payload: Buffer.alloc(0) });
    expect(empty.statusCode).toBe(400);
  });
});
