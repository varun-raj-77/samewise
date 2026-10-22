import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MATCHER_VERSION, MatchJobSchema, RunSummarySchema, type MatcherResult } from "@samewise/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { MatcherRunner } from "../src/matcher-process.js";

const sourceA = Buffer.from("id,name,status\nA1,Acme Corp,active\n");
const sourceB = Buffer.from("id,organization,status\nB1,Acme Corporation,inactive\n");
function matcherResult(): MatcherResult {
  return {
    contractVersion: "1.0.0",
    matcherVersion: MATCHER_VERSION,
    candidateEngineVersion: "candidate-engine-v0.4.0",
    blockingNormalizationVersion: "blocking-normalization-v0.1.0",
    featurePipelineVersion: "feature-pipeline-v0.2.0",
    matcherConfigVersion: "matcher-config-v0.3.0",
    matcherConfig: { frozen: true },
    candidates: [{
      candidateId: "candidate-1-1",
      aRowId: "A1",
      bRowId: "B1",
      aRecord: { id: "A1", name: "Acme Corp", status: "active" },
      bRecord: { id: "B1", organization: "Acme Corporation", status: "inactive" },
      rank: 1,
      matchScore: 0.72,
      runnerUpMargin: 0.2,
      band: "needs_review",
      collision: false,
      strongContradiction: false,
      blockingEvidence: [{ blockerId: "name_token_v1", keyHash: "0123456789abcdef" }],
      positiveEvidence: 0.72,
      conflictEvidence: 0,
      totalWeight: 2,
      evidence: [{
        mappingId: "name",
        label: "Organization name",
        aColumn: "name",
        bColumn: "organization",
        aValue: "Acme Corp",
        bValue: "Acme Corporation",
        normalizedA: "acme",
        normalizedB: "acme",
        fieldKind: "name_or_title",
        featurePipelineVersion: "feature-pipeline-v0.2.0",
        features: [{ name: "token_similarity", value: 1 }],
        outcome: "similar",
        evidenceClass: "partial_agreement",
        weight: 2,
        positiveContribution: 0.72,
        conflictContribution: 0,
        contribution: 0.72,
        explanationCode: "name_partial",
        explanation: "Organization name has partial normalized agreement.",
      }],
    }],
    onlyA: [],
    onlyB: [{ rowId: "B1", record: { id: "B1", organization: "Acme Corporation", status: "inactive" } }],
  };
}

function runner(match: MatcherRunner["match"]): MatcherRunner {
  return {
    async profile(input) {
      const names = input.side === "A" ? ["id", "name", "status"] : ["id", "organization", "status"];
      return {
        contractVersion: "1.0.0",
        datasetId: input.datasetId,
        side: input.side,
        originalFilename: input.originalFilename,
        sha256: input.sha256,
        rowCount: 1,
        columns: names.map((name) => ({
          name, inferredType: "string" as const, nullCount: 0,
          nullRate: 0, distinctCount: 1, distinctRate: 1, samples: [name],
        })),
      };
    },
    match,
  };
}

async function setup(app: ReturnType<typeof buildApp>): Promise<string> {
  const created = RunSummarySchema.parse((await app.inject({ method: "POST", url: "/api/runs" })).json());
  for (const [side, bytes] of [["A", sourceA], ["B", sourceB]] as const) {
    expect((await app.inject({
      method: "POST",
      url: `/api/runs/${created.runId}/datasets/${side}`,
      headers: { "content-type": "text/csv", "x-file-name": `${side}.csv` },
      payload: bytes,
    })).statusCode).toBe(201);
  }
  expect((await app.inject({
    method: "PUT",
    url: `/api/runs/${created.runId}/mappings`,
    payload: { mappings: [{
      mappingId: "name",
      label: "Organization name",
      aColumn: "name",
      bColumn: "organization",
      useForMatching: true,
      includeInMerge: false,
      normalizer: "text",
    }] },
  })).statusCode).toBe(200);
  return created.runId;
}

async function eventually(app: ReturnType<typeof buildApp>, runId: string, target: "running" | "succeeded" | "failed") {
  for (let i = 0; i < 120; i += 1) {
    const response = await app.inject({ method: "GET", url: `/api/runs/${runId}/match-jobs/current` });
    if (response.statusCode === 200) {
      const job = MatchJobSchema.parse(response.json());
      if (job.state === target) return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Matcher job never reached ${target}`);
}

describe("SW-016 recoverable matcher jobs", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  const roots: string[] = [];

  async function makeApp(match: MatcherRunner["match"], dataRoot?: string) {
    const root = dataRoot ?? await mkdtemp(join(tmpdir(), "samewise-match-jobs-"));
    if (!roots.includes(root)) roots.push(root);
    const app = buildApp({ dataRoot: root, matcher: runner(match) });
    apps.push(app);
    return { app, root };
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("persists queued/running/succeeded states and deduplicates idempotent requests", async () => {
    let finish!: (result: MatcherResult) => void;
    let signalStarted!: () => void;
    const matcherStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    let calls = 0;
    const { app } = await makeApp(async () => {
      calls += 1;
      return new Promise<MatcherResult>((resolve) => {
        finish = resolve;
        signalStarted();
      });
    });
    const runId = await setup(app);
    const url = `/api/runs/${runId}/match-jobs`;
    const first = await app.inject({ method: "POST", url, headers: { "idempotency-key": "reconciliation-0001" } });
    expect(first.statusCode).toBe(202);
    const job = MatchJobSchema.parse(first.json());
    expect(["queued", "running"]).toContain(job.state);
    await eventually(app, runId, "running");
    expect((await app.inject({ method: "POST", url, headers: { "idempotency-key": "reconciliation-0001" } })).json().jobId).toBe(job.jobId);
    expect((await app.inject({ method: "POST", url, headers: { "idempotency-key": "reconciliation-0002" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: `/api/runs/${runId}/mappings`, payload: { mappings: [] } })).statusCode).toBe(409);
    await matcherStarted;
    finish(matcherResult());
    const succeeded = await eventually(app, runId, "succeeded");
    expect(succeeded.attempts).toBe(1);
    expect(calls).toBe(1);
    const summary = RunSummarySchema.parse((await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json());
    expect(summary.summary).not.toBeNull();
    expect((await app.inject({ method: "POST", url, headers: { "idempotency-key": "reconciliation-0001" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/runs/${runId}/match` })).statusCode).toBe(409);
  });

  it("reclaims a running job from immutable sources after an API restart", async () => {
    let finishFirst!: (result: MatcherResult) => void;
    let signalStarted!: () => void;
    const matcherStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const { app: first, root } = await makeApp(async () => new Promise<MatcherResult>((resolve) => {
      finishFirst = resolve;
      signalStarted();
    }));
    const runId = await setup(first);
    const submitted = await first.inject({
      method: "POST", url: `/api/runs/${runId}/match-jobs`,
      headers: { "idempotency-key": "restart-test-0001" },
    });
    expect(submitted.statusCode).toBe(202);
    const initial = await eventually(first, runId, "running");
    await matcherStarted;
    await first.close();
    apps.splice(apps.indexOf(first), 1);
    finishFirst(matcherResult());

    let restoredCalls = 0;
    const { app: second } = await makeApp(async () => { restoredCalls += 1; return matcherResult(); }, root);
    const completed = await eventually(second, runId, "succeeded");
    expect(completed.jobId).toBe(initial.jobId);
    expect(completed.attempts).toBe(2);
    expect(restoredCalls).toBe(1);
  });

  it("retries explicit matcher failures and caps attempts without disclosing errors", async () => {
    let calls = 0;
    const { app } = await makeApp(async () => {
      calls += 1;
      if (calls <= 3) throw new Error("private source content must never reach the API");
      return matcherResult();
    });
    const runId = await setup(app);
    const submitted = await app.inject({
      method: "POST", url: `/api/runs/${runId}/match-jobs`,
      headers: { "idempotency-key": "failure-test-0001" },
    });
    const jobId = MatchJobSchema.parse(submitted.json()).jobId;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const failed = await eventually(app, runId, "failed");
      expect(failed.attempts).toBe(attempt);
      expect(failed.failureCode).toBe("matcher_failed");
      expect(JSON.stringify(failed)).not.toContain("private source content");
      expect((await app.inject({
        method: "POST",
        url: `/api/runs/${runId}/match-jobs`,
        headers: { "idempotency-key": "failure-test-0001" },
      })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/runs/${runId}/match` })).statusCode).toBe(409);
      const retry = await app.inject({ method: "POST", url: `/api/runs/${runId}/match-jobs/${jobId}/retry` });
      expect(retry.statusCode).toBe(attempt === 3 ? 409 : 202);
    }
    expect(calls).toBe(3);
  });

  it("rematerializes immutable source bytes when disposable matcher inputs were altered", async () => {
    const { app, root } = await makeApp(async (input) => {
      expect(await readFile(input.aPath)).toEqual(sourceA);
      expect(await readFile(input.bPath)).toEqual(sourceB);
      return matcherResult();
    });
    const runId = await setup(app);
    const files = (await readdir(join(root, runId))).filter((file) => file.endsWith(".csv"));
    expect(files).toHaveLength(2);
    await writeFile(join(root, runId, files[0]!), "tampered,working,file\\n");
    const submitted = await app.inject({
      method: "POST", url: `/api/runs/${runId}/match-jobs`,
      headers: { "idempotency-key": "immutable-input-0001" },
    });
    expect(submitted.statusCode).toBe(202);
    expect((await eventually(app, runId, "succeeded")).attempts).toBe(1);
  });

  it("requires a valid idempotency key before creating a job", async () => {
    const { app } = await makeApp(async () => matcherResult());
    const runId = await setup(app);
    expect((await app.inject({ method: "POST", url: `/api/runs/${runId}/match-jobs` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/runs/${runId}/match-jobs/current` })).statusCode).toBe(404);
  });
});
