import { spawn } from "node:child_process";
import { resolve } from "node:path";

import {
  DatasetProfileSchema,
  MATCHER_VERSION,
  MatcherResultSchema,
  type DatasetProfile,
  type ManualMapping,
  type MatcherResult,
} from "@samewise/contracts";

const DEFAULT_PROFILE_TIMEOUT_MS = 60_000;
const DEFAULT_MATCH_TIMEOUT_MS = 300_000;

export class MatcherTimeoutError extends Error {
  constructor() {
    super("Matcher process exceeded its execution deadline.");
    this.name = "MatcherTimeoutError";
  }
}

export class MatcherInterruptedError extends Error {
  constructor() {
    super("Matcher process was interrupted.");
    this.name = "MatcherInterruptedError";
  }
}

export interface MatcherRunner {
  profile(input: {
    datasetId: string;
    side: "A" | "B";
    originalFilename: string;
    sha256: string;
    path: string;
  }): Promise<DatasetProfile>;
  match(input: { aPath: string; bPath: string; mappings: ManualMapping[]; signal?: AbortSignal }): Promise<MatcherResult>;
}

interface MatcherRunnerOptions {
  profileTimeoutMs?: number;
  matchTimeoutMs?: number;
}

function checkedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error("Matcher process deadline must be a positive, safe millisecond interval.");
  }
  return value;
}

// A deadline is enforced on the real child process rather than racing an
// unkillable Promise. The worker must settle even if Python never responds.
function runPython(payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const python = process.env.SAMEWISE_PYTHON ?? "python";
  const sourceRoot = resolve(process.cwd(), "services/matcher/src");
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(python, ["-m", "samewise_matcher.cli", "process"], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONPATH: sourceRoot },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (value: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const terminate = (error: Error) => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may have already exited; settle with the original cause.
      }
      rejectOnce(error);
    };
    const onAbort = () => terminate(new MatcherInterruptedError());

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    // A killed child can close stdin before its pending write finishes.
    child.stdin.on("error", () => {});
    child.on("error", () => rejectOnce(new Error("Matcher process could not be started")));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        try {
          const parsed = JSON.parse(stdout) as { error?: { message?: string } };
          rejectOnce(new Error(parsed.error?.message ?? "Matcher rejected the request"));
        } catch {
          rejectOnce(new Error(stderr ? "Matcher process failed" : "Matcher returned no result"));
        }
        return;
      }
      try {
        resolveOnce(JSON.parse(stdout));
      } catch {
        rejectOnce(new Error("Matcher returned invalid JSON"));
      }
    });

    const timer = setTimeout(() => terminate(new MatcherTimeoutError()), timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    } else {
      child.stdin.end(JSON.stringify(payload));
    }
  });
}

export function createMatcherRunner(options: MatcherRunnerOptions = {}): MatcherRunner {
  const profileTimeoutMs = checkedTimeout(options.profileTimeoutMs ?? DEFAULT_PROFILE_TIMEOUT_MS);
  const matchTimeoutMs = checkedTimeout(options.matchTimeoutMs ?? DEFAULT_MATCH_TIMEOUT_MS);
  return {
    async profile(input) {
      return DatasetProfileSchema.parse(await runPython({ operation: "profile", ...input }, profileTimeoutMs));
    },
    async match(input) {
      const matcherMappings = input.mappings
        .filter((mapping) => mapping.useForMatching)
        .map(({ mappingId, label, aColumn, bColumn, normalizer, semanticFamily }) => ({
          mappingId, label, aColumn, bColumn, normalizer, semanticFamily: semanticFamily ?? "unknown", role: "identity" as const,
        }));
      return MatcherResultSchema.parse(await runPython({
        operation: "match",
        aPath: input.aPath,
        bPath: input.bPath,
        mappings: matcherMappings,
        candidateMode: "candidate_engine",
        matcherVersion: MATCHER_VERSION,
      }, matchTimeoutMs, input.signal));
    },
  };
}
