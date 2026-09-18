import { performance } from "node:perf_hooks";

import { type RunView } from "@samewise/contracts";
import { describe, expect, it } from "vitest";

import {
  buildExportSnapshot,
  exportRun,
  exportTrustedRun,
} from "../src/workflow-store.js";

const performanceDescribe = process.env.SAMEWISE_PERFORMANCE === "1"
  ? describe
  : describe.skip;

function largeReadyView(rowCount: number): RunView {
  const profile = (side: "A" | "B") => ({
    contractVersion: "1.0.0" as const,
    datasetId: `dataset-${side}`,
    side,
    originalFilename: `${side.toLowerCase()}.csv`,
    sha256: side === "A" ? "a".repeat(64) : "b".repeat(64),
    rowCount: side === "A" ? rowCount : 0,
    columns: [{
      name: "status",
      inferredType: "string" as const,
      nullCount: 0,
      nullRate: 0,
      distinctCount: 2,
      distinctRate: 0,
      samples: ["active", "inactive"],
    }],
  });
  return {
    contractVersion: "1.0.0",
    runId: `run-export-${rowCount}`,
    stage: "export",
    datasets: { A: profile("A"), B: profile("B") },
    mappings: [{
      mappingId: "status",
      label: "Status",
      aColumn: "status",
      bColumn: "status",
      useForMatching: false,
      includeInMerge: true,
      normalizer: "text",
    }],
    mappingVersion: "confirmed-mappings-v2",
    semanticMappingProvenance: null,
    matcherVersion: "explainable-matcher-v0.2.0",
    matcherProvenance: {
      matcherVersion: "explainable-matcher-v0.2.0",
      candidateEngineVersion: "candidate-engine-v0.3.0",
      blockingNormalizationVersion: "blocking-normalization-v0.1.0",
      featurePipelineVersion: "feature-pipeline-v0.1.0",
      matcherConfigVersion: "matcher-config-v0.2.0",
      matcherConfig: { frozen: true },
    },
    summary: { matched: 0, needsReview: 0, onlyA: rowCount, onlyB: 0 },
    candidates: [],
    decisions: [],
    conflicts: [],
    survivorshipPolicy: null,
    trustedExportReadiness: {
      ready: true,
      unresolvedIdentityCount: 0,
      unresolvedConflictCount: 0,
      eligibleConfirmedCount: 0,
      onlyACount: rowCount,
      onlyBCount: 0,
      blockers: [],
    },
    reviewQueue: [],
    reviewProgress: { total: 0, reviewed: 0, remaining: 0, deferred: 0 },
    reviewUndo: null,
    onlyA: Array.from({ length: rowCount }, (_, index) => ({
      rowId: `A${index.toString().padStart(6, "0")}`,
      record: { status: index % 2 ? "active" : "inactive" },
    })),
    onlyB: [],
  };
}

performanceDescribe("SW-011 export performance evidence", () => {
  it.each([10_000, 50_000])(
    "measures deterministic reconciliation, trusted, and manifest artifacts at %i rows",
    (rowCount) => {
      const view = largeReadyView(rowCount);
      let started = performance.now();
      const reconciliation = exportRun(view);
      const reconciliationMilliseconds = performance.now() - started;
      started = performance.now();
      const trusted = exportTrustedRun(view);
      const trustedMilliseconds = performance.now() - started;
      started = performance.now();
      const snapshot = buildExportSnapshot(view);
      const snapshotMilliseconds = performance.now() - started;
      const repeated = buildExportSnapshot(view);

      expect(repeated).toEqual(snapshot);
      expect(snapshot.reconciliation.content).toBe(reconciliation);
      expect(snapshot.trusted?.content).toBe(trusted);
      console.log(JSON.stringify({
        sw011ExportBenchmark: {
          rowCount,
          reconciliationMilliseconds: Number(reconciliationMilliseconds.toFixed(6)),
          trustedMilliseconds: Number(trustedMilliseconds.toFixed(6)),
          snapshotWithCsvRegenerationAndHashingMilliseconds: Number(snapshotMilliseconds.toFixed(6)),
          reconciliationBytes: Buffer.byteLength(reconciliation),
          trustedBytes: Buffer.byteLength(trusted),
          manifestBytes: Buffer.byteLength(snapshot.manifest.content),
        },
      }));
    },
  );
});
