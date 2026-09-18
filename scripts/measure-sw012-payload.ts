import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  LegacyManualMappingSchema,
  normalizeLegacyMapping,
} from "../packages/contracts/src/index.js";

import { buildApp } from "../apps/api/src/app.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
process.env.SAMEWISE_PYTHON ??= resolve(root, "services/matcher/.venv/Scripts/python.exe");
const fixtureRoot = resolve(root, ".samewise-data/generated-10k/fixtures/corrupted/organizations/organizations-candidates-10k-v1");
const aPath = join(fixtureRoot, "dataset_a.csv");
const bPath = join(fixtureRoot, "dataset_b.csv");
const mappingsPath = resolve(root, "evaluation/configs/organizations-confirmed-mappings-v1.json");
await mkdir(resolve(root, ".samewise-data"), { recursive: true });
const dataRoot = await mkdtemp(resolve(root, ".samewise-data/sw012-api-"));
const app = buildApp({
  dataRoot,
  semanticMapper: { async propose() { throw new Error("Semantic mapping is outside this benchmark."); } },
});

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

async function inject(input: Parameters<typeof app.inject>[0], expected = 200) {
  const started = performance.now();
  const response = await app.inject(input);
  const milliseconds = performance.now() - started;
  if (response.statusCode !== expected) {
    throw new Error(`${input.method} ${String(input.url)} returned ${response.statusCode}: ${response.body.slice(0, 500)}`);
  }
  return { response, milliseconds };
}

try {
  const sourceA = await readFile(aPath);
  const sourceB = await readFile(bPath);
  const legacyMappings = JSON.parse(await readFile(mappingsPath, "utf8")) as {
    mappings: unknown[];
  };
  const mappings = {
    mappings: legacyMappings.mappings.map((mapping) =>
      normalizeLegacyMapping(LegacyManualMappingSchema.parse(mapping)),
    ),
  };
  const created = await inject({ method: "POST", url: "/api/runs" }, 201);
  const runId = (created.response.json() as { runId: string }).runId;

  const uploadA = await inject({ method: "POST", url: `/api/runs/${runId}/datasets/A`, headers: { "content-type": "text/csv", "x-file-name": basename(aPath) }, payload: sourceA }, 201);
  const uploadB = await inject({ method: "POST", url: `/api/runs/${runId}/datasets/B`, headers: { "content-type": "text/csv", "x-file-name": basename(bPath) }, payload: sourceB }, 201);
  const mapped = await inject({ method: "PUT", url: `/api/runs/${runId}/mappings`, payload: mappings });

  const memoryBeforeMatch = process.memoryUsage();
  const matched = await inject({ method: "POST", url: `/api/runs/${runId}/match` });
  const memoryAfterMatch = process.memoryUsage();
  const summary = matched.response.json() as Record<string, unknown>;
  if ("candidates" in summary || "reviewQueue" in summary || "onlyA" in summary || "onlyB" in summary) {
    throw new Error("Run summary leaked an authoritative result array.");
  }

  const results = await inject({ method: "GET", url: `/api/runs/${runId}/results?offset=0&limit=50` });
  const review = await inject({ method: "GET", url: `/api/runs/${runId}/review?offset=0&limit=50&filter=all&sort=source` });
  const conflicts = await inject({ method: "GET", url: `/api/runs/${runId}/conflicts?offset=0&limit=50` });
  const reviewValue = review.response.json() as { items: Array<{ aRowId: string; topCandidateId: string; candidates: Array<{ candidateId: string }> }> };
  const firstReview = reviewValue.items[0];
  if (!firstReview) throw new Error("The fixture returned no review items.");
  const detail = await inject({ method: "GET", url: `/api/runs/${runId}/candidates/${firstReview.topCandidateId}` });

  const rankCase = reviewValue.items.find((item) => item.candidates.length > 1);
  let alternateDetailBytes: number | null = null;
  let rankSwitchPreservedState: boolean | null = null;
  if (rankCase) {
    const before = await inject({ method: "GET", url: `/api/runs/${runId}` });
    const alternate = await inject({ method: "GET", url: `/api/runs/${runId}/candidates/${rankCase.candidates[1]!.candidateId}` });
    const after = await inject({ method: "GET", url: `/api/runs/${runId}` });
    alternateDetailBytes = bytes(alternate.response.body);
    rankSwitchPreservedState = before.response.body === after.response.body;
  }

  const same = await inject({ method: "POST", url: `/api/runs/${runId}/candidates/${firstReview.topCandidateId}/decisions`, payload: { decision: "same_entity" } });
  const evidenceAfterSame = await inject({ method: "GET", url: `/api/runs/${runId}/evaluation-evidence` });
  const conflictsAfterSame = await inject({ method: "GET", url: `/api/runs/${runId}/conflicts?offset=0&limit=50` });
  const conflictValue = conflictsAfterSame.response.json() as { items: Array<{ conflictId: string }> };
  let resolutionRoundTrip = false;
  if (conflictValue.items[0]) {
    await inject({ method: "POST", url: `/api/runs/${runId}/conflicts/${conflictValue.items[0].conflictId}/resolutions`, payload: { action: "use_a" } });
    await inject({ method: "DELETE", url: `/api/runs/${runId}/conflicts/${conflictValue.items[0].conflictId}/resolution` });
    resolutionRoundTrip = true;
  }
  await inject({ method: "POST", url: `/api/runs/${runId}/review-undo` });
  const different = await inject({ method: "POST", url: `/api/runs/${runId}/candidates/${firstReview.topCandidateId}/decisions`, payload: { decision: "different_entity" } });
  await inject({ method: "POST", url: `/api/runs/${runId}/review-undo` });
  await inject({ method: "PATCH", url: `/api/runs/${runId}/review-items/${firstReview.aRowId}`, payload: { deferred: true } });
  await inject({ method: "PATCH", url: `/api/runs/${runId}/review-items/${firstReview.aRowId}`, payload: { deferred: false } });

  const exportOne = await inject({ method: "GET", url: `/api/runs/${runId}/export` });
  const exportTwo = await inject({ method: "GET", url: `/api/runs/${runId}/export` });
  const manifestOne = await inject({ method: "GET", url: `/api/runs/${runId}/manifest` });
  const manifestTwo = await inject({ method: "GET", url: `/api/runs/${runId}/manifest` });
  const manifestValue = manifestOne.response.json() as { export: { artifacts: Array<{ kind: string; sha256: string }> } };
  const reconciliationArtifact = manifestValue.export.artifacts.find((artifact) => artifact.kind === "reconciliation_report");
  const report = {
    benchmarkVersion: "sw-012-bounded-projection-benchmark-v1",
    fixture: "organizations-candidates-10k-v1",
    measuredAt: new Date().toISOString(),
    environment: {
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      logicalProcessors: cpus().length,
      physicalMemoryBytes: totalmem(),
      node: process.version,
    },
    source: { aBytes: sourceA.byteLength, bBytes: sourceB.byteLength },
    timingsMilliseconds: {
      uploadA: uploadA.milliseconds,
      uploadB: uploadB.milliseconds,
      mappings: mapped.milliseconds,
      matchThroughFastify: matched.milliseconds,
      firstResultsPage: results.milliseconds,
      firstReviewPage: review.milliseconds,
      firstConflictPage: conflicts.milliseconds,
      firstEvidenceDetail: detail.milliseconds,
    },
    payloads: {
      preProjectionMatcherResultBaselineBytes: 56_892_493,
      preProjectionMatcherResultBaselineSha256: "8115ff85dcda59d68797bcd84894454dade77007e2357329bf303de969a91ba8",
      matchSummaryBytes: bytes(matched.response.body),
      runSummaryBytes: bytes((await inject({ method: "GET", url: `/api/runs/${runId}` })).response.body),
      resultsPage50Bytes: bytes(results.response.body),
      reviewPage50Bytes: bytes(review.response.body),
      conflictPage50Bytes: bytes(conflicts.response.body),
      candidateEvidenceDetailBytes: bytes(detail.response.body),
      alternateCandidateEvidenceDetailBytes: alternateDetailBytes,
      sameDecisionSummaryBytes: bytes(same.response.body),
      differentDecisionSummaryBytes: bytes(different.response.body),
      evaluationEvidenceAfterOneDecisionBytes: bytes(evidenceAfterSame.response.body),
      reconciliationExportBytes: bytes(exportOne.response.body),
      manifestBytes: bytes(manifestOne.response.body),
    },
    pages: {
      results: (results.response.json() as { page: unknown }).page,
      review: (review.response.json() as { page: unknown }).page,
      conflictsBeforeDecision: (conflicts.response.json() as { page: unknown }).page,
      conflictsAfterSameDecision: (conflictsAfterSame.response.json() as { page: unknown }).page,
    },
    memoryObservation: {
      method: "Node process.memoryUsage before and immediately after the Fastify match request; includes parsed authoritative state and response construction and is not an isolated retained-size measurement.",
      beforeMatch: memoryBeforeMatch,
      afterMatch: memoryAfterMatch,
      heapUsedDeltaBytes: memoryAfterMatch.heapUsed - memoryBeforeMatch.heapUsed,
      rssDeltaBytes: memoryAfterMatch.rss - memoryBeforeMatch.rss,
      priorPythonPeakTracedBytes: 825_638_427,
      priorPythonPeakScope: "SW-011 traced Python allocations from pre-load through serialization and truth evaluation; matcher internals are unchanged in SW-012.",
    },
    behaviorChecks: {
      summaryOmitsAuthoritativeArrays: true,
      rankSwitchPreservedState,
      sameDecisionRecorded: ((same.response.json() as { reviewProgress: { reviewed: number } }).reviewProgress.reviewed > 0),
      differentDecisionRecorded: ((different.response.json() as { reviewProgress: { reviewed: number } }).reviewProgress.reviewed > 0),
      humanEvaluationEvidencePreserved: ((evidenceAfterSame.response.json() as { labeledCandidateCount: number }).labeledCandidateCount === 1),
      fieldResolutionRoundTrip: resolutionRoundTrip,
      exportRepeatedBytesEqual: exportOne.response.body === exportTwo.response.body,
      exportSha256: hash(exportOne.response.body),
      manifestRepeatedBytesEqual: manifestOne.response.body === manifestTwo.response.body,
      manifestReconciliationHashMatchesBytes: reconciliationArtifact?.sha256 === hash(exportOne.response.body),
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await app.close();
}
