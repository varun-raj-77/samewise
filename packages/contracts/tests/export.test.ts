import { describe, expect, it } from "vitest";

import {
  RECONCILIATION_EXPORT_VERSION,
  RUN_MANIFEST_VERSION,
  RunManifestSchema,
} from "../src/index.js";

describe("run manifest contract", () => {
  it("validates the versioned machine-readable export manifest", () => {
    const manifest = RunManifestSchema.parse({
      manifestVersion: RUN_MANIFEST_VERSION,
      run: {
        runId: "run-1", status: "identity_unresolved", stage: "review",
        snapshot: { descriptorVersion: "export-snapshot-v1.0.0", authoritativeStateSha256: "a".repeat(64) },
        relevantTimestamps: { mappingProposalCreatedAt: null, firstIdentityDecisionAt: null, lastIdentityDecisionAt: null, policyConfiguredAt: null, lastResolutionAt: null },
      },
      sourceDatasets: {
        A: { side: "A", datasetId: "dataset-a", originalFilename: "a.csv", sha256: "b".repeat(64), rowCount: 1, profileSchemaVersion: "1.0.0" },
        B: { side: "B", datasetId: "dataset-b", originalFilename: "b.csv", sha256: "c".repeat(64), rowCount: 1, profileSchemaVersion: "1.0.0" },
      },
      semanticMapping: { mappingVersion: "confirmed-mappings-v1", confirmedMappings: [], ai: null },
      candidateGeneration: { candidateEngineVersion: "candidate-engine-v0.2.0", blockingNormalizationVersion: "blocking-normalization-v0.1.0", candidateConfigVersion: null, candidateConfigAvailability: "not_retained_by_product_run" },
      matcher: { featurePipelineVersion: "feature-pipeline-v0.1.0", matcherVersion: "explainable-matcher-v0.2.0", matcherConfigVersion: "matcher-config-v0.2.0", matcherConfig: {}, scoreSemanticsVersion: "explainable-matcher-v0.2.0" },
      identity: { systemEstablishedLinkCount: 0, humanSameCount: 0, humanDifferentCount: 0, pendingCount: 1, deferredCount: 0, collisionRelatedCount: 0 },
      survivorship: { policySchemaVersion: "survivorship-policy-v1", policyVersion: null, configuredFieldPolicies: [], manualResolutionCount: 0, ruleGeneratedResolutionCount: 0, keepBothCount: 0, unresolvedConflictCount: 0 },
      evaluation: { applicable: false, snapshotId: null, snapshotVersion: null, reason: "No versioned evaluation snapshot is attached to this ordinary product run." },
      export: { artifacts: [{ kind: "reconciliation_report", version: RECONCILIATION_EXPORT_VERSION, filename: "samewise-run-1-reconciliation.csv", mediaType: "text/csv; charset=utf-8", sha256: "d".repeat(64), byteLength: 123 }] },
    });
    expect(manifest.manifestVersion).toBe("run-manifest-v1.0.0");
  });

  it("rejects unversioned hashes and unknown fields", () => {
    expect(() => RunManifestSchema.parse({ manifestVersion: "run-manifest-v1" })).toThrow();
  });
});
