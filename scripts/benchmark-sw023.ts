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
} from "../packages/contracts/src/index.js";

import { createMatcherRunner } from "../apps/api/src/matcher-process.js";
import {
  analyzeRecoveryImpact,
  diagnoseAutomaticDeferrals,
  type IdentityTruthFixture,
} from "../apps/api/src/one-to-one-benchmark.js";
import { automaticIdentityCandidateIds, conservativeAutomaticIdentityCandidateIds } from "../apps/api/src/identity-selection.js";

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
  const impact = analyzeRecoveryImpact(result.candidates, truth);
  const deferralDiagnostics = diagnoseAutomaticDeferrals(result.candidates);
  // Warm both implementations, then measure each 51 times on the same input.
  const legacyTimes: number[] = [];
  const recoveryTimes: number[] = [];
  for (let i = 0; i < 56; i += 1) {
    const t0 = performance.now();
    conservativeAutomaticIdentityCandidateIds(result.candidates);
    const t1 = performance.now();
    automaticIdentityCandidateIds(result.candidates);
    const t2 = performance.now();
    if (i >= 5) { legacyTimes.push(t1 - t0); recoveryTimes.push(t2 - t1); }
  }
  const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[25]!;
  const selection = {
    sw021SelectorMedianMs: median(legacyTimes),
    sw023SelectorMedianMs: median(recoveryTimes),
    repetitions: 51,
  };
  // A pass requires held-out evidence that recovery does not trade away
  // established false-positive safety on these frozen synthetic fixtures.
  if (impact.delta.falseAutoPairs > 0 || impact.delta.duplicateBClaims !== 0) {
    throw new Error("Recovery increases false automatic links or repeats a B row on the frozen fixture.");
  }
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
    deferralDiagnostics,
  };
}

async function main() {
  if (process.argv.length > 2) throw new Error("SW-023 benchmark has no variable fixture/threshold arguments.");
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
    benchmarkVersion: "one-to-one-recovery-v1",
    scope: "Synthetic fixtures only. Frozen SW-021 conservative policy vs new SW-023 propagation on identical matcher results. No humans simulated.",
    definitions: {
      sw021: "Frozen conservative one-to-one selector from SW-021, not pre-SW-021 matcher.",
      sw023: "Propagated one-to-one anchors without selecting among unresolved competing auto candidates.",
      reviewRateAllARows: "Candidate-bearing A rows left without an automatic assignment / all A rows.",
      autoMatchPrecision: "True assigned pairs / automatically assigned pairs, null when none assigned.",
      retainedCandidateRecall: "Frozen truth-pair coverage among final retained scored candidates; upstream blocker recall not measured here.",
      duplicateBClaims: "Additional auto assignments of a B row after its first claim.",
      timings: "Matcher subprocess elapsed once; selector median each over 51 in-process repetitions; not production latency.",
      privacy: "Ground truth is used only after matcher execution and never sent to Python.",
    },
    fixtures: reports,
  };
  const output = join(root, "evaluation/reports/sw-023/latest-ci.json");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

await main();
