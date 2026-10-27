import { readFile } from "node:fs/promises";

import { evaluateReviewStudy } from "../apps/api/src/review-study-evaluation.js";

async function main(): Promise<void> {
  const [truthPath, sessionsPath, extra] = process.argv.slice(2);
  if (!truthPath || !sessionsPath || extra) {
    throw new Error("Usage: pnpm study:sw029 -- <offline-truth.json> <recorded-sessions.json>");
  }
  const truth = JSON.parse(await readFile(truthPath, "utf8")) as unknown;
  const sessions = JSON.parse(await readFile(sessionsPath, "utf8")) as unknown;
  if (!truth || typeof truth !== "object" || Array.isArray(truth)
    || !sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
    throw new Error("Both study inputs must be JSON objects.");
  }
  const truthInput = truth as Record<string, unknown>;
  const observedInput = sessions as Record<string, unknown>;
  if (Object.keys(observedInput).some((key) => !["taskSetId", "sessions"].includes(key))) {
    throw new Error("Recorded sessions may contain only taskSetId and sessions; hidden truth is not part of reviewer traces.");
  }
  if (truthInput.taskSetId !== observedInput.taskSetId) {
    throw new Error("The recorded task set does not match the hidden truth set.");
  }
  const score = evaluateReviewStudy({ ...truthInput, sessions: observedInput.sessions });
  process.stdout.write(JSON.stringify(score, null, 2) + "\n");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown study evaluation failure";
  process.stderr.write("SW-029 study evaluation failed: " + message + "\n");
  process.exitCode = 1;
});
