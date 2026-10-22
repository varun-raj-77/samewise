import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { PostgresRunRepository } from "../src/postgres-run-repository.js";
import { RunRevisionConflictError, RunRepositoryError } from "../src/run-repository.js";

const databaseUrl = process.env.SAMEWISE_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("SW-015B PostgreSQL durability and CAS", () => {
  const repositories: PostgresRunRepository[] = [];

  function connect(): PostgresRunRepository {
    const repo = new PostgresRunRepository(databaseUrl!);
    repositories.push(repo);
    return repo;
  }

  afterEach(async () => {
    await Promise.all(repositories.splice(0).map((repo) => repo.close()));
  });

  it("persists immutable sources, restores snapshots, and rejects stale writers across connections", async () => {
    const writer = connect();
    const staleWriter = connect();
    await Promise.all([writer.initialize(), staleWriter.initialize()]);
    const runId = `run-${randomUUID()}`;
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
});
