import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateCollisionCatalog } from "../apps/api/src/collision-evaluation.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const filename = join(root, "evaluation/fixtures/sw-024/independent-collision-cases-v1.json");
const out = join(root, "evaluation/reports/sw-024/latest-ci.json");

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("SW-024 only runs its frozen fixture.");
  const bytes = await readFile(filename);
  const source: unknown = JSON.parse(bytes.toString("utf8"));
  const evaluation = evaluateCollisionCatalog(source);
  if (evaluation.aggregate.conservative.duplicateBClaims !== 0) {
    throw new Error("Conservative one-to-one selector assigned a B row twice.");
  }
  const report = {
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    labelBasis: "Hand-authored synthetic identity labels. No matcher run, no AI, no sampled user records.",
    ...evaluation,
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

await main();
