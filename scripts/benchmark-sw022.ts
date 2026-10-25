import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LegacyManualMappingSchema,
  MATCHER_VERSION,
  MatcherResultSchema,
  SemanticFamilySchema,
  normalizeLegacyMapping,
} from "@samewise/contracts";

import { createMatcherRunner } from "../apps/api/src/matcher-process.js";
import {
  analyzeOneToOneImpact,
  measureSelectionRuntime,
  type IdentityTruthFixture,
} from "../apps/api/src/one-to-one-benchmark.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = ["organizations-dev-v1", "organizations-matcher-holdout-1200-v1"];
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

async function runOne(fixture: string) {
  const csvRoot = join(root, "fixtures/corrupted/organizations", fixture);
  const truthFile = join(root, "fixtures/ground-truth/organizations", fixture, "identity_truth.json");
  const mappingFile = join(root, "evaluation/configs/organizations-confirmed-mappings-v3-semantic.json");
  const aPath = join(csvRoot, "dataset_a.csv");
  const bPath = join(csvRoot, "dataset_b.csv");
  const [aBytes, bBytes, truthBytes, mappingBytes] = await Promise.all([
    readFile(aPath), readFile(bPath), readFile(truthFile), readFile(mappingFile),
  ]);
  const inputMappings = JSON.parse(mappingBytes.toString("utf8")) as { mappings: unknown[] };
  if (!Array.isArray(inputMappings.mappings)) throw new Error("Missing frozen mapping list.");
  const mappings = inputMappings.mappings.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid frozen mapping.");
    const raw = item as Record<string, unknown>;
    const legacy = LegacyManualMappingSchema.parse({
      mappingId: raw.mappingId, label: raw.label, aColumn: raw.aColumn, bColumn: raw.bColumn,
      role: raw.role, normalizer: raw.normalizer,
    });
    return { ...normalizeLegacyMapping(legacy), ...(raw.semanticFamily ? { semanticFamily: SemanticFamilySchema.parse(raw.semanticFamily) } : {}) };
  });
  const truth = JSON.parse(truthBytes.toString("utf8")) as IdentityTruthFixture;
  const matcher = createMatcherRunner();
  // The matcher sees only product-visible CSVs and mappings. Truth is supplied
  // exclusively to this post-hoc metric computation, never sent to Python.
  const started = performance.now();
  const result = MatcherResultSchema.parse(await matcher.match({
    aPath, bPath, mappings: mappings.filter((mapping) => mapping.useForMatching),
  }));
  const matcherWallMs = performance.now() - started;
  const impact = analyzeOneToOneImpact(result.candidates, truth);
  const selection = measureSelectionRuntime(result.candidates);
  return {
    fixture,
    fixtureSource: "synthetic_ground_truth",
    matcherVersion: MATCHER_VERSION,
    candidateEngineVersion: result.candidateEngineVersion,
    inputFingerprints: {
      aSha256: hash(aBytes), bSha256: hash(bBytes),
      truthSha256: hash(truthBytes), mappingsSha256: hash(mappingBytes),
    },
    timings: {
      matcherSubprocessWallMs: matcherWallMs,
      ...selection,
      note: "Selector medians measure in-process selection only; Python subprocess wall time is measured once. Not production SLOs.",
    },
    ...impact,
  };
}

async function main() {
  if (process.argv.length > 2) throw new Error("SW-022 benchmark has no variable fixture/threshold arguments.");
  process.chdir(root);
  if (!process.env.SAMEWISE_PYTHON) {
    const local = process.platform === "win32"
      ? join(root, "services/matcher/.venv/Scripts/python.exe")
      : join(root, "services/matcher/.venv/bin/python");
    if (existsSync(local)) process.env.SAMEWISE_PYTHON = local;
  }
  const reports = [];
  for (const fixture of fixtures) {
    reports.push(await runOne(fixture));
  }
  const report = {
    benchmarkVersion: "one-to-one-impact-v1",
    scope: "Synthetic fixtures only. Same current matcher output for both assignment policies; no humans simulated.",
    definitions: {
      autoMatchPrecision: "True assigned pairs / automatically assigned pairs; null when no auto-assignment.",
      autoMatchRecallPerMatchableARow: "True automatically assigned pairs / A records with any cross-source truth link.",
      reviewRateAllARows: "A records with retained candidates but no auto-assignment / all A records.",
      reviewRateMatchableARows: "Matchable A records with retained candidates but no auto-assignment / matchable A records.",
      retainedCandidatePairRecall: "True cross-source pairs among final retained candidate pairs / all cross-source true pairs; NOT pre-scoring candidate generation recall.",
      retainedPairReductionFraction: "1 - retained candidate count/(A rows × B rows); NOT pre-scoring candidate generation reduction.",
      duplicateBClaims: "Extra automatically assigned claims for already-claimed B row IDs.",
      runtime: "Measured CI environment only, matcher run once per fixture, selector medians across 51 repeats.",
    },
    fixtures: reports,
  };
  const output = join(root, "evaluation/reports/sw-022/latest-ci.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

await main();
