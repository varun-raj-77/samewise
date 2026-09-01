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
  },
};

describe("SW-003 API workflow", () => {
  let dataRoot: string;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => { dataRoot = await mkdtemp(join(tmpdir(), "samewise-api-")); app = buildApp({ dataRoot, matcher }); });
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
    expect(RunViewSchema.parse(resolved.json()).conflicts[0]?.resolution?.action).toBe("use_a");
    const exported = await app.inject({ method: "GET", url: `/api/runs/${runId}/export` });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain("identity_decision_source");
    expect(exported.body).toContain("human");
    expect(exported.body).toContain("'=SUM(1,2)");
    const after = await Promise.all(paths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")));
    expect(after).toEqual(before);
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

  it("rejects unsupported, empty, duplicate, and invalid mapping uploads safely", async () => {
    const created = RunViewSchema.parse((await app.inject({ method: "POST", url: "/api/runs" })).json());
    const unsupported = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/datasets/A`, headers: { "content-type": "application/json", "x-file-name": "a.xlsx" }, payload: {} });
    expect(unsupported.statusCode).toBe(415);
    const empty = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/datasets/A`, headers: { "content-type": "text/csv", "x-file-name": "a.csv" }, payload: Buffer.alloc(0) });
    expect(empty.statusCode).toBe(400);
  });
});
