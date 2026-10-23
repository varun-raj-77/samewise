import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DatasetProfileSchema,
  ManualMappingSchema,
  MATCHER_VERSION,
  MatcherResultSchema,
  type DatasetProfile,
  type ManualMapping,
  type MatcherResult,
} from "@samewise/contracts";

import type { MatcherRunner } from "./matcher-process.js";
import type { RunRepository } from "./run-repository.js";

export const MATCHER_REPLAY_VERIFICATION_VERSION = "matcher-replay-verification-v1";

export class MatcherReplayError extends Error {
  constructor(public readonly code: "run_not_matched" | "source_integrity_failed" | "replay_inputs_invalid" | "incompatible_matcher_version") {
    super("Recorded matcher replay could not be verified safely.");
    this.name = "MatcherReplayError";
  }
}

export interface MatcherReplayVerification {
  verificationVersion: typeof MATCHER_REPLAY_VERIFICATION_VERSION;
  runId: string;
  storedRevision: number;
  outcome: "identical" | "different";
  sourceSha256: { A: string; B: string };
  storedMatcherVersion: string;
  replayMatcherVersion: string | null;
  storedResultSha256: string;
  replayResultSha256: string | null;
}

// Hash a stable representation so property insertion order does not create
// spurious drift. Array ordering remains significant to matcher semantics.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function recordedData(state: unknown): {
  profiles: { A: DatasetProfile; B: DatasetProfile };
  mappings: ManualMapping[];
  result: MatcherResult;
} {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new MatcherReplayError("replay_inputs_invalid");
  }
  const recorded = state as Record<string, unknown>;
  if (!recorded.result) throw new MatcherReplayError("run_not_matched");
  if (typeof recorded.result !== "object" || Array.isArray(recorded.result)
    || (recorded.result as Record<string, unknown>).matcherVersion !== MATCHER_VERSION) {
    throw new MatcherReplayError("incompatible_matcher_version");
  }
  const result = MatcherResultSchema.safeParse(recorded.result);
  const datasets = recorded.datasets;
  if (!datasets || typeof datasets !== "object" || Array.isArray(datasets)) {
    throw new MatcherReplayError("replay_inputs_invalid");
  }
  const sources = datasets as Record<string, unknown>;
  const aProfile = DatasetProfileSchema.safeParse(
    sources.A && typeof sources.A === "object" && !Array.isArray(sources.A)
      ? (sources.A as Record<string, unknown>).profile : null,
  );
  const bProfile = DatasetProfileSchema.safeParse(
    sources.B && typeof sources.B === "object" && !Array.isArray(sources.B)
      ? (sources.B as Record<string, unknown>).profile : null,
  );
  if (!result.success || !aProfile.success || !bProfile.success
    || aProfile.data.side !== "A" || bProfile.data.side !== "B"
    || !Array.isArray(recorded.mappings)) {
    throw new MatcherReplayError("replay_inputs_invalid");
  }
  const mappings = recorded.mappings.map((mapping) => ManualMappingSchema.safeParse(mapping));
  if (mappings.some((mapping) => !mapping.success)) {
    throw new MatcherReplayError("replay_inputs_invalid");
  }
  const validMappings = mappings.map((mapping) => mapping.data!);
  if (!validMappings.some((mapping) => mapping.useForMatching)) {
    throw new MatcherReplayError("replay_inputs_invalid");
  }
  return {
    profiles: { A: aProfile.data, B: bProfile.data },
    mappings: validMappings,
    result: result.data,
  };
}

/**
 * Offline, one-shot replay of the stored *matcher result* only.
 *
 * Neither identity decisions nor field survivorship are rerun or rewritten.
 * The authoritative repository is only read. Fresh temporary copies of both
 * fingerprint-verified sources are removed even when matching throws.
 *
 * This must not be exposed as an unauthenticated HTTP route: replay is costly.
 */
export async function verifyRecordedMatch(
  repository: RunRepository,
  matcher: MatcherRunner,
  runId: string,
): Promise<MatcherReplayVerification> {
  const snapshot = await repository.loadState(runId);
  if (!snapshot) throw new MatcherReplayError("replay_inputs_invalid");
  const { profiles, mappings, result } = recordedData(snapshot.state);
  const sources = await Promise.all([
    repository.readSource(runId, "A"),
    repository.readSource(runId, "B"),
  ]);
  if (hash(sources[0]) !== profiles.A.sha256 || hash(sources[1]) !== profiles.B.sha256) {
    throw new MatcherReplayError("source_integrity_failed");
  }

  const baseline = {
    verificationVersion: MATCHER_REPLAY_VERIFICATION_VERSION,
    runId,
    storedRevision: snapshot.revision,
    sourceSha256: { A: profiles.A.sha256, B: profiles.B.sha256 },
    storedMatcherVersion: result.matcherVersion,
    storedResultSha256: hash(canonicalJson(result)),
  };
  const temporary = await mkdtemp(join(tmpdir(), "samewise-offline-replay-"));
  try {
    const aPath = join(temporary, "A.csv");
    const bPath = join(temporary, "B.csv");
    await writeFile(aPath, sources[0], { flag: "wx", mode: 0o600 });
    await writeFile(bPath, sources[1], { flag: "wx", mode: 0o600 });
    const replay = MatcherResultSchema.parse(await matcher.match({
      aPath, bPath, mappings: structuredClone(mappings.filter((mapping) => mapping.useForMatching)),
    }));
    const replayHash = hash(canonicalJson(replay));
    return {
      ...baseline,
      outcome: replay.matcherVersion === result.matcherVersion && replayHash === baseline.storedResultSha256
        ? "identical" : "different",
      replayMatcherVersion: replay.matcherVersion,
      replayResultSha256: replayHash,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
