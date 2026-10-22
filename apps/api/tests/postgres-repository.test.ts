import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";

import { buildApp } from "../src/app.js";
import type { MatcherRunner } from "../src/matcher-process.js";
import { PostgresRunRepository } from "../src/postgres-run-repository.js";
import { RunRevisionConflictError, RunRepositoryError } from "../src/run-repository.js";

const databaseUrl = process.env.SAMEWISE_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("SW-015B PostgreSQL durability and CAS", () => {
  const repositories: PostgresRunRepository[] = [];
  const testRunIds: string[] = [];

  function connect(): PostgresRunRepository {
    const repo = new PostgresRunRepository(databaseUrl!);
    repositories.push(repo);
    return repo;
  }

  afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repo) => repo.close()));
    if (!testRunIds.length) return;

    // Repository-level tests intentionally persist arbitrary JSON. Remove only
    // their rows before an API instance hydrates full workflow states.
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      for (const runId of testRunIds.splice(0)) {
        await sql`DELETE FROM samewise_run_snapshots WHERE run_id = ${runId}`;
        await sql`DELETE FROM samewise_source_blobs WHERE run_id = ${runId}`;
      }
    } finally {
      await sql.end();
    }
  });

  it("persists immutable sources, restores snapshots, and rejects stale writers across connections", async () => {
    const writer = connect();
    const staleWriter = connect();
    await Promise.all([writer.initialize(), staleWriter.initialize()]);
    const runId = `run-${randomUUID()}`;
    testRunIds.push(runId);
    const sourceA = Buffer.from("id,name\nA1,Acme\n");
    const sourceB = Buffer.from("id,name\nB1,Acme Corp\n");
    await writer.saveSource(runId, "A", sourceA);
    await staleWriter.saveSource(runId, "A", Buffer.from(sourceA));
    await staleWriter.saveSource(runId, "B", sourceB);
    expect(await staleWriter.readSource(runId, "A")).toEqual(sourceA);
    expect(await writer.readSource(runId, "B")).toEqual(sourceB);
    await expect(writer.saveSource(runId, "A", Buffer.from("different bytes")))
      .rejects.toBeInstanceOf(RunRepositoryError);

    expect(await writer.saveState(runId, { stage: "upload", who: "first" }, 0)).toBe(1);
    const first = await staleWriter.loadState(runId);
    expect(first).toMatchObject({ revision: 1, state: { stage: "upload", who: "first" } });
    expect((await staleWriter.loadStates()).find((item) => item.runId === runId)).toMatchObject({ revision: 1 });

    expect(await writer.saveState(runId, { stage: "profile", who: "second" }, 1)).toBe(2);
    await expect(staleWriter.saveState(runId, { stage: "mapping", who: "stale" }, 1))
      .rejects.toBeInstanceOf(RunRevisionConflictError);
    await expect(staleWriter.saveState(runId, { stage: "mapping", who: "duplicate" }, 0))
      .rejects.toBeInstanceOf(RunRevisionConflictError);

    const contested = await Promise.allSettled([
      writer.saveState(runId, { stage: "review", winner: "A" }, 2),
      staleWriter.saveState(runId, { stage: "review", winner: "B" }, 2),
    ]);
    expect(contested.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(contested.filter((item) => item.status === "rejected")).toHaveLength(1);
    const recovered = await staleWriter.loadState(runId);
    expect(recovered?.revision).toBe(3);
    expect(["A", "B"]).toContain((recovered?.state as { winner?: string }).winner);
  });

  it("retains source bytes and state after closing and recreating the repository", async () => {
    const repo = connect();
    await repo.initialize();
    const runId = `run-${randomUUID()}`;
    testRunIds.push(runId);
    const source = Buffer.from("record,name\n1,Orchard Signal\n");
    await repo.saveSource(runId, "A", source);
    await repo.saveState(runId, { marker: "persisted", decisions: ["same_entity"] }, 0);
    await repo.close();
    repositories.splice(repositories.indexOf(repo), 1);

    const restarted = connect();
    await restarted.initialize();
    const state = await restarted.loadState(runId);
    expect(state).toMatchObject({ revision: 1, state: { marker: "persisted", decisions: ["same_entity"] } });
    expect(await restarted.readSource(runId, "A")).toEqual(source);
  });

  it("rolls back the revision when an immutable source conflicts", async () => {
    const repo = connect();
    await repo.initialize();
    const runId = `run-${randomUUID()}`;
    testRunIds.push(runId);
    const original = Buffer.from("id,name\nA1,Original\n");
    expect(await repo.saveStateWithSources(runId, { label: "original" }, 0, [{ side: "A", bytes: original }])).toBe(1);
    await expect(repo.saveStateWithSources(
      runId, { label: "should-not-commit" }, 1,
      [{ side: "A", bytes: Buffer.from("id,name\nA1,Different\n") }],
    )).rejects.toBeInstanceOf(RunRepositoryError);
    expect(await repo.loadState(runId)).toMatchObject({ revision: 1, state: { label: "original" } });
    expect(await repo.readSource(runId, "A")).toEqual(original);
  });
  it("returns 409 on a stale API write, reloads authority, then permits a safe retry", async () => {
    const matcher: MatcherRunner = {
      async profile(input) {
        return {
          contractVersion: "1.0.0",
          datasetId: input.datasetId,
          side: input.side,
          originalFilename: input.originalFilename,
          sha256: input.sha256,
          rowCount: 1,
          columns: ["id", "name"].map((name) => ({
            name, inferredType: "string" as const, nullCount: 0, nullRate: 0,
            distinctCount: 1, distinctRate: 1, samples: [name],
          })),
        };
      },
      async match() { throw new Error("Not needed for storage test."); },
    };

    const apiA = buildApp({
      dataRoot: await mkdtemp(join(tmpdir(), "samewise-pg-api-a-")),
      matcher,
      runRepository: new PostgresRunRepository(databaseUrl!),
    });
    const created = await apiA.inject({ method: "POST", url: "/api/runs" });
    expect(created.statusCode).toBe(201);
    const runId = created.json().runId as string;
    testRunIds.push(runId);

    const apiB = buildApp({
      dataRoot: await mkdtemp(join(tmpdir(), "samewise-pg-api-b-")),
      matcher,
      runRepository: new PostgresRunRepository(databaseUrl!),
    });
    try {
      await apiB.ready();
      const uploadA = await apiA.inject({
        method: "POST",
        url: `/api/runs/${runId}/datasets/A`,
        headers: { "content-type": "text/csv", "x-file-name": "a.csv" },
        payload: Buffer.from("id,name\nA1,Acme\n"),
      });
      expect(uploadA.statusCode).toBe(201);

      const uploadRequest = {
        method: "POST" as const,
        url: `/api/runs/${runId}/datasets/B`,
        headers: { "content-type": "text/csv", "x-file-name": "b.csv" },
        payload: Buffer.from("id,name\nB1,Acme Corp\n"),
      };
      const stale = await apiB.inject(uploadRequest);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe("stale_run_revision");

      const persisted = connect();
      await persisted.initialize();
      await expect(persisted.readSource(runId, "B")).rejects.toBeInstanceOf(RunRepositoryError);

      const refreshed = await apiB.inject({ method: "GET", url: `/api/runs/${runId}` });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().datasets.A).toBeTruthy();
      expect(refreshed.json().datasets.B).toBeFalsy();

      const retryRequest = { ...uploadRequest, payload: Buffer.from("id,name\nB2,Fresh Corp\n") };
      const retry = await apiB.inject(retryRequest);
      expect(retry.statusCode).toBe(201);
      expect(retry.json().datasets.A).toBeTruthy();
      expect(retry.json().datasets.B).toBeTruthy();
      expect(await persisted.readSource(runId, "B")).toEqual(retryRequest.payload);
    } finally {
      await Promise.all([apiA.close(), apiB.close()]);
    }
  });
});
