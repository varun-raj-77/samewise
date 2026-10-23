import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

import { createMatcherRunner } from "./matcher-process.js";
import { verifyRecordedMatch } from "./matcher-replay.js";
import { FileRunRepository } from "./run-repository.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--data-root" || args[2] !== "--run-id"
    || !args[1] || !/^run-[0-9a-f-]+$/i.test(args[3] ?? "")) {
    process.stderr.write("Usage: pnpm --filter @samewise/api exec tsx src/replay-cli.ts --data-root PATH --run-id RUN_ID\n");
    process.exitCode = 2;
    return;
  }
  if (process.env.DATABASE_URL) {
    process.stderr.write("Offline verification only supports a file-backed repository; unset DATABASE_URL for a local file-backed run.\n");
    process.exitCode = 2;
    return;
  }
  // Resolve relative arguments before moving to the monorepo root, which is
  // where the existing production Python runner expects its source tree.
  const dataRoot = resolve(args[1]!);
  const runId = args[3]!;
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  process.chdir(repoRoot);
  if (!process.env.SAMEWISE_PYTHON) {
    const candidate = process.platform === "win32"
      ? join(repoRoot, "services/matcher/.venv/Scripts/python.exe")
      : join(repoRoot, "services/matcher/.venv/bin/python");
    if (existsSync(candidate)) process.env.SAMEWISE_PYTHON = candidate;
  }

  const repository = new FileRunRepository(join(dataRoot, "_run-store"));
  try {
    const verification = await verifyRecordedMatch(repository, createMatcherRunner(), runId);
    process.stdout.write(JSON.stringify(verification) + "\n");
    if (verification.outcome !== "identical") process.exitCode = 1;
  } catch {
    // Do not print exception payloads: subprocess errors or filesystem paths
    // could include sensitive uploaded data.
    process.stderr.write("Offline matcher replay could not be verified. Confirm the run, immutable files, and Python environment.\n");
    process.exitCode = 2;
  } finally {
    await repository.close();
  }
}

await main();
