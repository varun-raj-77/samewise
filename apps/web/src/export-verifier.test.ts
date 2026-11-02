import { createHash } from "node:crypto";

import { RECONCILIATION_EXPORT_VERSION, RUN_MANIFEST_VERSION, TRUSTED_EXPORT_VERSION, type RunManifest } from "@samewise/contracts";
import { describe, expect, it } from "vitest";

import { BrowserExportVerificationError, verifyBrowserExport, type BrowserExportFile } from "./export-verifier.js";

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = async (bytes: Uint8Array) => hex(bytes);

function fixture(ready = true) {
  const runId = "run-browser-1";
  const report: BrowserExportFile = {
    filename: `samewise-${runId}-reconciliation.csv`,
    bytes: encoder.encode("id,name\r\n1,Café ☕\r\n"),
  };
  const trusted: BrowserExportFile = {
    filename: `samewise-${runId}-trusted-merged.csv`,
    bytes: encoder.encode("id,name\r\n1,Café ☕\r\n"),
  };
  const artifact = (kind: "reconciliation_report" | "trusted_merged_output", file: BrowserExportFile) => ({
    kind,
    version: kind === "reconciliation_report" ? RECONCILIATION_EXPORT_VERSION : TRUSTED_EXPORT_VERSION,
    filename: file.filename,
    mediaType: "text/csv; charset=utf-8" as const,
    sha256: hex(file.bytes),
    byteLength: file.bytes.byteLength,
  });
  const source = <Side extends "A" | "B">(side: Side) => ({
    side,
    datasetId: `dataset-${side}`,
    originalFilename: `${side}.csv`,
    sha256: "a".repeat(64),
    rowCount: 1,
    profileSchemaVersion: "1.0.0",
  });
  const manifest: RunManifest = {
    manifestVersion: RUN_MANIFEST_VERSION,
    run: {
      runId, status: ready ? "trusted_ready" : "identity_unresolved", stage: "export",
      snapshot: { descriptorVersion: "export-snapshot-v1.0.0", authoritativeStateSha256: "b".repeat(64) },
      relevantTimestamps: {
        mappingProposalCreatedAt: null, firstIdentityDecisionAt: null, lastIdentityDecisionAt: null,
        policyConfiguredAt: null, lastResolutionAt: null,
      },
    },
    sourceDatasets: { A: source("A"), B: source("B") },
    semanticMapping: { mappingVersion: "confirmed-mappings-v3", confirmedMappings: [], ai: null },
    candidateGeneration: {
      candidateEngineVersion: "candidate-engine-v0.4.0",
      blockingNormalizationVersion: "blocking-normalization-v0.1.0",
      candidateConfigVersion: null,
      candidateConfigAvailability: "not_retained",
      evidencePlanVersion: "1.0.0",
      evidencePlanSha256: hex(encoder.encode("{}")),
      evidencePlan: {},
    },
    matcher: {
      featurePipelineVersion: "feature-pipeline-v0.2.0",
      matcherVersion: "explainable-matcher-v0.3.0",
      matcherConfigVersion: "matcher-config-v0.3.0",
      matcherConfig: {},
      scoreSemanticsVersion: "1.0.0",
    },
    identity: {
      systemEstablishedLinkCount: 0, humanSameCount: 0, humanDifferentCount: 0,
      pendingCount: ready ? 0 : 1, deferredCount: 0, collisionRelatedCount: 0,
      humanBatchPairCount: 0, reviewSignatureVersion: "1.0.0",
    },
    survivorship: {
      policySchemaVersion: "1.0.0", policyVersion: null, configuredFieldPolicies: [],
      manualResolutionCount: 0, ruleGeneratedResolutionCount: 0, keepBothCount: 0,
      unresolvedConflictCount: 0,
    },
    evaluation: {
      applicable: false, snapshotId: null, snapshotVersion: null,
      reason: "No versioned evaluation snapshot is attached to this ordinary product run.",
    },
    export: {
      artifacts: [artifact("reconciliation_report", report), ...(ready ? [artifact("trusted_merged_output", trusted)] : [])],
    },
  };
  return { manifest, files: ready ? [report, trusted] : [report] };
}

async function fails(manifest: unknown, files: BrowserExportFile[], code: string) {
  try {
    await verifyBrowserExport(manifest, files, digest);
    throw new Error("Expected verification failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(BrowserExportVerificationError);
    expect((error as BrowserExportVerificationError).code).toBe(code);
  }
}

describe("SW-034 browser export integrity check", () => {
  it("accepts the exact UTF-8 bytes for a trusted run regardless of file order", async () => {
    const { manifest, files } = fixture();
    const result = await verifyBrowserExport(manifest, files.slice().reverse(), digest);
    expect(result.status).toBe("trusted_ready");
    expect(result.verified).toHaveLength(2);
    expect(result.verified[0]?.byteLength).toBeGreaterThan("id,name\r\n1,Café ☕\r\n".length);
  });

  it("supports reconciliation-only manifests", async () => {
    const { manifest, files } = fixture(false);
    expect((await verifyBrowserExport(manifest, files, digest)).verified).toHaveLength(1);
  });

  it("refuses missing, extra, renamed, duplicate, modified and truncated artifacts", async () => {
    const { manifest, files } = fixture();
    await fails(manifest, [files[0]!], "file_set_mismatch");
    await fails(manifest, [...files, files[0]!], "file_set_mismatch");
    await fails(manifest, [{ ...files[0]!, filename: "wrong.csv" }, files[1]!], "missing_file");
    await fails(manifest, [files[0]!, files[0]!], "duplicate_file");
    const changed = new Uint8Array(files[0]!.bytes);
    changed[0] = changed[0]! ^ 1;
    await fails(manifest, [{ ...files[0]!, bytes: changed }, files[1]!], "sha256_mismatch");
    await fails(manifest, [{ ...files[0]!, bytes: files[0]!.bytes.subarray(1) }, files[1]!], "byte_length_mismatch");
  });

  it("rejects inconsistent readiness, plan digest and invalid manifests", async () => {
    const { manifest, files } = fixture();
    await fails({ ...manifest, run: { ...manifest.run, status: "identity_unresolved" } }, files, "readiness_mismatch");
    await fails({ ...manifest, candidateGeneration: { ...manifest.candidateGeneration, evidencePlan: { other: true } } }, files, "evidence_plan_mismatch");
    await fails({ ...manifest, manifestVersion: "wrong-version" }, files, "invalid_manifest");
    await fails({ ...manifest, identity: { ...manifest.identity, pendingCount: 1 } }, files, "unresolved_trusted_run");
  });

  it("documents the limit: replacing manifest and CSV together can still pass", async () => {
    const { manifest, files } = fixture();
    const changed = new Uint8Array(files[0]!.bytes);
    changed[0] = changed[0]! ^ 1;
    const altered = { ...manifest, export: { artifacts: manifest.export.artifacts.map((item) =>
      item.kind === "reconciliation_report" ? { ...item, sha256: hex(changed) } : item) } };
    expect((await verifyBrowserExport(altered, [{ ...files[0]!, bytes: changed }, files[1]!], digest)).verified).toHaveLength(2);
  });
});
