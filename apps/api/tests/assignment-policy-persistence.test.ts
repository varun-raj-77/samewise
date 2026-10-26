import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ASSIGNMENT_POLICY_VERSION, RunSummarySchema } from "@samewise/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { InMemoryRunRepository } from "../src/run-repository.js";

function historicalState(runId: string, assignmentPolicyVersion?: string) {
  return {
    runId, stage: "upload", datasets: {}, mappings: [],
    decisions: [], conflicts: [], deferredARowIds: [], undoStack: [],
    previewedRuleIds: [], mergePlanRevision: 0, rulesApplied: false,
    ...(assignmentPolicyVersion === undefined ? {} : { assignmentPolicyVersion }),
  };
}

describe("SW-024 saved run assignment policy version", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined))); });

  it("persists a separate policy version for a new run, even before matcher execution", async () => {
    const runRepository = new InMemoryRunRepository();
    const app = buildApp({ dataRoot: await mkdtemp(join(tmpdir(), "samewise-policy-")), runRepository });
    apps.push(app);
    const created = RunSummarySchema.parse((await app.inject({ method: "POST", url: "/api/runs" })).json());
    expect(created.assignmentPolicyVersion).toBe(ASSIGNMENT_POLICY_VERSION);
    expect(created.assignmentPolicyOrigin).toBe("explicit");
    const state = await runRepository.loadState(created.runId);
    expect(state?.state).toMatchObject({ assignmentPolicyVersion: ASSIGNMENT_POLICY_VERSION, assignmentPolicyOrigin: "explicit" });
  });

  it("reopens pre-SW-024 snapshots with their actual historical SW-021 semantics, without changing stored bytes", async () => {
    const runRepository = new InMemoryRunRepository();
    const runId = "run-a001";
    const historical = historicalState(runId);
    await runRepository.saveState(runId, historical, 0);
    const before = await runRepository.loadState(runId);
    const app = buildApp({ dataRoot: await mkdtemp(join(tmpdir(), "samewise-policy-")), runRepository });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
    expect(response.statusCode).toBe(200);
    const run = RunSummarySchema.parse(response.json());
    expect(run.assignmentPolicyVersion).toBe(ASSIGNMENT_POLICY_VERSION);
    expect(run.assignmentPolicyOrigin).toBe("legacy_unversioned_fallback");
    expect(await runRepository.loadState(runId)).toEqual(before);
  });

  it("fails closed on a future or unrecognized stored assignment selector rather than silently replaying it", async () => {
    const runRepository = new InMemoryRunRepository();
    const runId = "run-a002";
    await runRepository.saveState(runId, historicalState(runId, "assignment-v-next-unknown"), 0);
    const app = buildApp({ dataRoot: await mkdtemp(join(tmpdir(), "samewise-policy-")), runRepository });
    apps.push(app);
    await expect(app.ready()).rejects.toThrow(/unsupported identity-assignment policy/);
  });
});
