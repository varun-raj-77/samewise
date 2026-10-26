import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LegacyManualMappingSchema,
  MatcherResultSchema,
  SemanticFamilySchema,
  normalizeLegacyMapping,
} from "../packages/contracts/src/index.js";
import { createMatcherRunner } from "../apps/api/src/matcher-process.js";
import { measureActualMatcherStages } from "../apps/api/src/e2e-matcher-evaluation.js";
import type { IdentityTruthFixture } from "../apps/api/src/one-to-one-benchmark.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scenarioNames = ["moderate-distinct", "high-corruption", "duplicate-dense"] as const;
const fingerprints = (content: Buffer) => createHash("sha256").update(content).digest("hex");

function pythonExecutable(): string {
  const local = process.platform === "win32"
    ? join(root, "services/matcher/.venv/Scripts/python.exe")
    : join(root, "services/matcher/.venv/bin/python");
  return process.env.SAMEWISE_PYTHON || (existsSync(local) ? local : "python");
}
function callPython(python: string, args: string[]): number {
  const started = performance.now();
  const result = spawnSync(python, ["-m", "samewise_matcher.cli", ...args], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: join(root, "services/matcher/src") },
    encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Python fixture/candidate stage failed (${args.slice(0, 2).join(" ")}): ${(result.stderr || result.stdout || result.error?.message || "no output").slice(0, 1000)}`);
  }
  return performance.now() - started;
}
async function runScenario(
  scenario: typeof scenarioNames[number],
  mappingPath: string,
  mappingSha256: string,
  mappings: ReturnType<typeof normalizeLegacyMapping>[],
  python: string,
  scratch: string,
) {
  const configuration = join(root, "evaluation/benchmark-configs/sw-025", scenario + ".json");
  const configBytes = await readFile(configuration);
  const parsedConfig = JSON.parse(configBytes.toString("utf8")) as { fixture_name?: string };
  if (!parsedConfig.fixture_name?.startsWith("organizations-sw025-")) {
    throw new Error("Unexpected fixture name in frozen SW-025 benchmark.");
  }
  const fixtureName = parsedConfig.fixture_name;
  const fixtureMs = callPython(python, [
    "fixtures", "generate-config", "--config", configuration, "--output-root", scratch,
  ]);
  const csvRoot = join(scratch, "fixtures/corrupted/organizations", fixtureName);
  const aPath = join(csvRoot, "dataset_a.csv");
  const bPath = join(csvRoot, "dataset_b.csv");
  const truthPath = join(scratch, "fixtures/ground-truth/organizations", fixtureName, "identity_truth.json");
  const stageOutputPath = join(scratch, "candidate-stage-" + scenario + ".json");
  // Treat labels as held-out evaluation input: neither candidate generation
  // nor the product matcher can read the truth file through their requests.
  const [aBytes, bBytes] = await Promise.all([readFile(aPath), readFile(bPath)]);
  const candidateStageWallMs = callPython(python, [
    "candidates", "generate", "--a", aPath, "--b", bPath,
    "--mappings", mappingPath, "--output", stageOutputPath,
  ]);
  const generatedPayload = JSON.parse(await readFile(stageOutputPath, "utf8")) as {
    engineVersion?: string; candidates?: {aRowId:string; bRowId:string}[]; aRowCount?: number; bRowCount?: number;
  };
  if (!Array.isArray(generatedPayload.candidates)) throw new Error("Invalid candidate-stage output.");
  const matcher = createMatcherRunner();
  const t0 = performance.now();
  const matcherOutput = MatcherResultSchema.parse(await matcher.match({aPath,bPath,mappings: mappings.filter(m=>m.useForMatching)}));
  const matcherWallMs = performance.now() - t0;
  if (generatedPayload.engineVersion !== matcherOutput.candidateEngineVersion) {
    throw new Error("Candidate generation stage and product matcher used different engine versions.");
  }
  // Load hidden labels only after both independent matcher invocations ended.
  const truthBytes = await readFile(truthPath);
  const truthPayload = JSON.parse(truthBytes.toString("utf8")) as IdentityTruthFixture;
  const metrics = measureActualMatcherStages(truthPayload, generatedPayload.candidates, matcherOutput.candidates);
  if (generatedPayload.aRowCount !== metrics.rowCounts.a || generatedPayload.bRowCount !== metrics.rowCounts.b) {
    throw new Error("Candidate stage row counts disagree with frozen truth.");
  }
  return {
    scenario,
    fixtureName,
    generatorConfigSha256: fingerprints(configBytes),
    datasetASha256: fingerprints(aBytes),
    datasetBSha256: fingerprints(bBytes),
    truthSha256: fingerprints(truthBytes),
    confirmedMappingsSha256: mappingSha256,
    matcherVersion: matcherOutput.matcherVersion,
    candidateEngineVersion: matcherOutput.candidateEngineVersion,
    assignmentPolicyVersion: metrics.assignment.policy,
    wallTimesMs: {
      fixtureGeneration: fixtureMs,
      candidateStage: candidateStageWallMs,
      productMatcherSubprocess: matcherWallMs,
    },
    ...metrics,
  };
}

async function main() {
  if (process.argv.length !== 2) throw new Error("SW-025 benchmark accepts no mutable fixture or threshold arguments.");
  process.chdir(root);
  const scratch = await mkdtemp(join(tmpdir(), "samewise-sw025-"));
  try {
    const mappingPath = join(root, "evaluation/configs/organizations-confirmed-mappings-v3-semantic.json");
    const mappingBytes = await readFile(mappingPath);
    const mappingPayload = JSON.parse(mappingBytes.toString("utf8")) as {mappings?:unknown[]};
    if (!Array.isArray(mappingPayload.mappings)) throw new Error("Frozen semantic mapping list is invalid.");
    const mappings = mappingPayload.mappings.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid semantic mapping.");
      const value = item as Record<string, unknown>;
      const legacy = LegacyManualMappingSchema.parse({
        mappingId:value.mappingId,label:value.label,aColumn:value.aColumn,bColumn:value.bColumn,
        role:value.role,normalizer:value.normalizer,
      });
      return {...normalizeLegacyMapping(legacy),...(value.semanticFamily ? {semanticFamily:SemanticFamilySchema.parse(value.semanticFamily)} : {})};
    });
    const python = pythonExecutable();
    if (!process.env.SAMEWISE_PYTHON) process.env.SAMEWISE_PYTHON = python;
    const reports = [];
    for (const scenario of scenarioNames) {
      reports.push(await runScenario(scenario, mappingPath, fingerprints(mappingBytes), mappings, python, scratch));
    }
    const report = {
      benchmarkVersion: "real-matcher-end-to-end-v1",
      fixtureBasis: "New synthetic seeded CSV fixtures generated by existing versioned fixture generator; not independently human-adjudicated or real user datasets.",
      algorithmScope: "Python candidate generation -> Python explainable matcher -> exact production SW-021 one-to-one selector; no human decisions simulated.",
      definitions: {
        candidateRecall: "All true cross-source pair links emitted by independent upstream blocker pass / all true links, including duplicated occurrences.",
        candidateReduction: "One minus generated pair count over A × B. Unlike prior reports this measures pre-scoring candidate generation.",
        generatedTruePairsLostInScoringOrRetention: "Generated true links absent from the public retained matcher output; score threshold, classification, and alternative pruning are not distinguishable here.",
        retainedTruthPairRecall: "True pairs surviving matcher scoring and alternative retention / all truth pairs.",
        autoMatchPrecision: "Correct globally auto-assigned one-to-one links / all auto-assigned links; null if none.",
        reviewRateAllARows: "A records retaining ≥1 scored alternative but not assigned automatically / all A rows.",
        benchmarkTimings: "Separate wall times on the CI worker, with Python process startup included; not production SLO or memory measurements.",
        dataBoundary: "Hidden truth is used exclusively after both matcher and candidate stages finish; never provided to those processes.",
      },
      scenarios: reports,
    };
    const output = join(root, "evaluation/reports/sw-025/latest-ci.json");
    await mkdir(dirname(output), {recursive:true});
    await writeFile(output, JSON.stringify(report,null,2) + "\n");
    process.stdout.write(JSON.stringify(report,null,2) + "\n");
  } finally {
    await rm(scratch,{recursive:true,force:true});
  }
}
await main();
