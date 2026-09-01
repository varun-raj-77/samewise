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

export interface MatcherRunner {
  profile(input: {
    datasetId: string;
    side: "A" | "B";
    originalFilename: string;
    sha256: string;
    path: string;
  }): Promise<DatasetProfile>;
  match(input: { aPath: string; bPath: string; mappings: ManualMapping[] }): Promise<MatcherResult>;
}

function runPython(payload: unknown): Promise<unknown> {
  const python = process.env.SAMEWISE_PYTHON ?? "python";
  const sourceRoot = resolve(process.cwd(), "services/matcher/src");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, ["-m", "samewise_matcher.cli", "process"], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONPATH: sourceRoot },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", () => reject(new Error("Matcher process could not be started")));
    child.on("close", (code) => {
      if (code !== 0) {
        try {
          const parsed = JSON.parse(stdout) as { error?: { message?: string } };
          reject(new Error(parsed.error?.message ?? "Matcher rejected the request"));
        } catch {
          reject(new Error(stderr ? "Matcher process failed" : "Matcher returned no result"));
        }
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        reject(new Error("Matcher returned invalid JSON"));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export function createMatcherRunner(): MatcherRunner {
  return {
    async profile(input) {
      return DatasetProfileSchema.parse(await runPython({ operation: "profile", ...input }));
    },
    async match(input) {
      return MatcherResultSchema.parse(await runPython({
        operation: "match",
        aPath: input.aPath,
        bPath: input.bPath,
        mappings: input.mappings,
        candidateMode: "candidate_engine",
        matcherVersion: MATCHER_VERSION,
      }));
    },
  };
}
