import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MATCHER_VERSION,
  type MatcherResult,
  type DatasetProfile,
  type ManualMapping,
} from "@samewise/contracts";
import { describe, expect, it } from "vitest";

import type { MatcherRunner } from "../src/matcher-process.js";
import { MatcherReplayError, verifyRecordedMatch } from "../src/matcher-replay.js";
import { FileRunRepository, InMemoryRunRepository, type RunRepository } from "../src/run-repository.js";

const runId = "run-1234abcd";
const aBytes = Buffer.from("id,name\n1,Secret Acme\n");
const bBytes = Buffer.from("id,company\n2,Secret Acme Corp\n");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const mappings: ManualMapping[] = [{
  mappingId: "name",
  label: "Company",
  aColumn: "name",
  bColumn: "company",
  normalizer: "text",
  useForMatching: true,
  includeInMerge: false,
}];

function profile(side: "A" | "B"): DatasetProfile {
  const col = side === "A" ? "name" : "company";
  return {
    contractVersion: "1.0.0",
    datasetId: side === "A" ? "dataset-a" : "dataset-b",
    side, originalFilename: side + ".csv",
    sha256: hash(side === "A" ? aBytes : bBytes),
    rowCount: 1,
    columns: [{
      name: col, inferredType: "string",
      nullCount: 0, nullRate: 0, distinctCount: 1, distinctRate: 1,
      samples: ["redacted"],
    }],
  };
}

function result(): MatcherResult {
  return {
    contractVersion: "1.0.0",
    matcherVersion: MATCHER_VERSION,
    candidateEngineVersion: "candidate-engine-v0.4.0",
    blockingNormalizationVersion: "blocking-normalization-v0.1.0",
    featurePipelineVersion: "feature-pipeline-v0.2.0",
    matcherConfigVersion: "matcher-config-v0.3.0",
    matcherConfig: { stable: true },
    candidates: [],
    onlyA: [{ rowId: "1", record: { id: "1", name: "Secret Acme" } }],
    onlyB: [{ rowId: "2", record: { id: "2", company: "Secret Acme Corp" } }],
  };
}

async function recorded(repository: RunRepository, recordedResult: unknown = result()): Promise<void> {
  await repository.initialize();
  await repository.saveSource(runId, "A", aBytes);
  await repository.saveSource(runId, "B", bBytes);
  await repository.saveState(runId, {
    datasets: { A: { profile: profile("A") }, B: { profile: profile("B") } },
    mappings, result: recordedResult,
    decisions: [{ humanDecision: "same_entity", candidateId: "candidate-1-2" }],
    conflicts: [],
  }, 0);
}

function runner(match: MatcherRunner["match"]): MatcherRunner {
  return {
    async profile() { throw new Error("Replay must never reprofile or rewrite sources."); },
    match,
  };
}

describe("SW-019 offline replay and source lineage", () => {
  it("replays copied immutable sources and reports identical matcher output without persisting or leaking rows", async () => {
    const repository = new InMemoryRunRepository();
    await recorded(repository);
    const stateBefore = await repository.loadState(runId);
    let calls = 0;
    const verified = await verifyRecordedMatch(repository, runner(async (input) => {
      calls += 1;
      expect(await readFile(input.aPath)).toEqual(aBytes);
      expect(await readFile(input.bPath)).toEqual(bBytes);
      expect(input.mappings).toEqual(mappings);
      return result();
    }), runId);
    expect(verified).toMatchObject({
      runId, storedRevision: 1, outcome: "identical",
      storedMatcherVersion: MATCHER_VERSION,
      replayMatcherVersion: MATCHER_VERSION,
      sourceSha256: { A: hash(aBytes), B: hash(bBytes) },
    });
    expect(verified.storedResultSha256).toBe(verified.replayResultSha256);
    expect(JSON.stringify(verified)).not.toContain("Secret Acme");
    expect(calls).toBe(1);
    expect(await repository.loadState(runId)).toEqual(stateBefore);
    expect(await repository.readSource(runId, "A")).toEqual(aBytes);
  });

  it("verifies a real file-backed snapshot after reopening its repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "samewise-file-replay-test-"));
    try {
      const first = new FileRunRepository(join(root, "_run-store"));
      await recorded(first);
      await first.close();
      const restored = new FileRunRepository(join(root, "_run-store"));
      try {
        const before = await restored.loadState(runId);
        const verified = await verifyRecordedMatch(restored, runner(async () => result()), runId);
        expect(verified.outcome).toBe("identical");
        expect(verified.storedRevision).toBe(1);
        expect(await restored.loadState(runId)).toEqual(before);
      } finally {
        await restored.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports matcher drift without changing a historical result or human decisions", async () => {
    const repository = new InMemoryRunRepository();
    await recorded(repository);
    const before = await repository.loadState(runId);
    const verified = await verifyRecordedMatch(repository, runner(async () => ({
      ...result(),
      matcherConfig: { stable: false },
    })), runId);
    expect(verified.outcome).toBe("different");
    expect(verified.storedResultSha256).not.toEqual(verified.replayResultSha256);
    expect(await repository.loadState(runId)).toEqual(before);
  });

  it("rejects corrupt immutable source bytes before invoking matcher", async () => {
    class DamagedRepository extends InMemoryRunRepository {
      override async readSource(id: string, side: "A" | "B"): Promise<Buffer> {
        const bytes = await super.readSource(id, side);
        return side === "A" ? Buffer.from("corrupted") : bytes;
      }
    }
    const repository = new DamagedRepository();
    await recorded(repository);
    let calls = 0;
    await expect(verifyRecordedMatch(repository, runner(async () => {
      calls += 1;
      return result();
    }), runId)).rejects.toMatchObject({ code: "source_integrity_failed" });
    expect(calls).toBe(0);
  });

  it("does not silently replay an incompatible matcher version", async () => {
    const repository = new InMemoryRunRepository();
    await recorded(repository, { ...result(), matcherVersion: "historical-matcher-v1" });
    let calls = 0;
    await expect(verifyRecordedMatch(repository, runner(async () => {
      calls += 1;
      return result();
    }), runId)).rejects.toMatchObject({ code: "incompatible_matcher_version" });
    expect(calls).toBe(0);
  });

  it("never manufactures a match result for a run that was not matched", async () => {
    const repository = new InMemoryRunRepository();
    await recorded(repository, undefined);
    const state = await repository.loadState(runId);
    await repository.saveState(runId, {
      ...(state!.state as object),
      result: null,
    }, 1);
    await expect(verifyRecordedMatch(repository, runner(async () => result()), runId))
      .rejects.toMatchObject({ code: "run_not_matched" });
  });

  it("removes the private temporary source copies if matcher execution fails", async () => {
    const repository = new InMemoryRunRepository();
    await recorded(repository);
    let staged = "";
    await expect(verifyRecordedMatch(repository, runner(async (input) => {
      staged = input.aPath;
      throw new Error("matcher error with sensitive input");
    }), runId)).rejects.toThrow();
    expect(staged).not.toBe("");
    await expect(access(staged)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await repository.readSource(runId, "A")).toEqual(aBytes);
  });

  it("uses a closed replay error type for validation failures", () => {
    expect(new MatcherReplayError("replay_inputs_invalid").message)
      .not.toContain("Secret Acme");
  });
});
