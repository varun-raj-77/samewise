import { createHash } from "node:crypto";

import type { RunView } from "@samewise/contracts";
import { describe, expect, it } from "vitest";

import { buildExportSnapshot } from "../src/workflow-store.js";
import {
  PortableExportVerificationError,
  verifyPortableExport,
} from "../src/portable-export-verifier.js";

function dataset(side: "A" | "B") {
  return {
    contractVersion: "1.0.0" as const,
    datasetId: `dataset-${side}`,
    side,
    originalFilename: `${side.toLowerCase()}.csv`,
    sha256: side === "A" ? "a".repeat(64) : "b".repeat(64),
    rowCount: side === "A" ? 1 : 0,
    columns: [],
  };
}

function view(ready = true): RunView {
  return {
    contractVersion: "1.0.0",
    runId: "run-portable-integrity",
    stage: "export",
    datasets: { A: dataset("A"), B: dataset("B") },
    mappings: [{ mappingId: "label", label: "Label", aColumn: "label", bColumn: "label", useForMatching: false, includeInMerge: true, normalizer: "text" }],
    mappingVersion: "confirmed-v1",
    semanticMappingProvenance: null,
    matcherVersion: "explainable-matcher-v0.3.0",
    matcherProvenance: {
      matcherVersion: "explainable-matcher-v0.3.0",
      candidateEngineVersion: "candidate-engine-v0.4.0",
      blockingNormalizationVersion: "blocking-normalization-v0.1.0",
      featurePipelineVersion: "feature-pipeline-v0.2.0",
      matcherConfigVersion: "matcher-config-v0.3.0",
      matcherConfig: { frozen: true },
    },
    summary: { matched: 0, needsReview: ready ? 0 : 1, onlyA: 1, onlyB: 0 },
    candidates: [],
    decisions: [],
    conflicts: [],
    survivorshipPolicy: null,
    trustedExportReadiness: {
      ready,
      unresolvedIdentityCount: ready ? 0 : 1,
      unresolvedConflictCount: 0,
      eligibleConfirmedCount: 0,
      onlyACount: 1,
      onlyBCount: 0,
      blockers: ready ? [] : ["Identity review remains unresolved."],
    },
    reviewQueue: [],
    reviewProgress: { total: 0, reviewed: 0, remaining: 0, deferred: 0 },
    reviewUndo: null,
    onlyA: [{ rowId: "A1", record: { status: "=SUM(1,2)", label: "Café ☕" } }],
    onlyB: [],
  } as RunView;
}

function fixture(ready = true) {
  const snapshot = buildExportSnapshot(view(ready));
  return {
    manifest: structuredClone(snapshot.manifest.value),
    files: [
      { filename: snapshot.reconciliation.filename, bytes: Buffer.from(snapshot.reconciliation.content, "utf8") },
      ...(snapshot.trusted ? [{ filename: snapshot.trusted.filename, bytes: Buffer.from(snapshot.trusted.content, "utf8") }] : []),
    ],
  };
}

function expectFailure(callback: () => unknown, code: string) {
  try {
    callback();
    throw new Error("Expected verification to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(PortableExportVerificationError);
    expect((error as PortableExportVerificationError).code).toBe(code);
  }
}

describe("SW-030 portable export verifier", () => {
  it("accepts actual deterministic trusted export bytes with matching manifest hashes", () => {
    const { manifest, files } = fixture();
    const first = verifyPortableExport(manifest, files);
    expect(first.status).toBe("trusted_ready");
    expect(first.verified.map((artifact) => artifact.kind)).toEqual(["reconciliation_report", "trusted_merged_output"]);
    expect(first.verified[0]?.byteLength).toBe(files[0]?.bytes.byteLength);
    expect(verifyPortableExport(manifest, [...files].reverse())).toEqual(first);
  });

  it("accepts actual reconciliation-only output and never invents a trusted file", () => {
    const { manifest, files } = fixture(false);
    expect(verifyPortableExport(manifest, files)).toMatchObject({
      status: "identity_unresolved",
      verified: [{ kind: "reconciliation_report" }],
    });
  });

  it("rejects a same-length single-byte CSV modification", () => {
    const { manifest, files } = fixture();
    const changed = files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }));
    changed[0]!.bytes[10] ^= 1;
    expectFailure(() => verifyPortableExport(manifest, changed), "sha256_mismatch");
  });

  it("rejects truncation and missing or extra supplied artifacts", () => {
    const { manifest, files } = fixture();
    expectFailure(() => verifyPortableExport(manifest, [{ ...files[0]!, bytes: files[0]!.bytes.subarray(1) }, files[1]!]), "byte_length_mismatch");
    expectFailure(() => verifyPortableExport(manifest, [files[0]!]), "file_set_mismatch");
    expectFailure(() => verifyPortableExport(manifest, [...files, files[0]!]), "file_set_mismatch");
    expectFailure(() => verifyPortableExport(manifest, [{ ...files[0]!, filename: "swapped.csv" }, files[1]!]), "missing_file");
    expectFailure(() => verifyPortableExport(manifest, [files[0]!, files[0]!]), "duplicate_file");
  });

  it("rejects manifest artifact substitutions, duplicate kinds, and false readiness", () => {
    const { manifest, files } = fixture();
    manifest.export.artifacts[0]!.filename = "unrelated.csv";
    expectFailure(() => verifyPortableExport(manifest, files), "artifact_metadata_mismatch");

    const duplicate = fixture();
    duplicate.manifest.export.artifacts[1]!.kind = "reconciliation_report";
    expectFailure(() => verifyPortableExport(duplicate.manifest, duplicate.files), "duplicate_artifact_kind");

    const unready = fixture();
    unready.manifest.run.status = "identity_unresolved";
    expectFailure(() => verifyPortableExport(unready.manifest, unready.files), "readiness_mismatch");

    const unresolved = fixture();
    unresolved.manifest.identity.pendingCount = 1;
    expectFailure(() => verifyPortableExport(unresolved.manifest, unresolved.files), "unresolved_trusted_run");
  });

  it("rejects altered evidence-plan content and malformed versioned contracts", () => {
    const { manifest, files } = fixture();
    manifest.candidateGeneration.evidencePlan = { injected: true };
    expectFailure(() => verifyPortableExport(manifest, files), "evidence_plan_mismatch");

    const invalid = fixture();
    (invalid.manifest as unknown as { manifestVersion: string }).manifestVersion = "unknown-version";
    expectFailure(() => verifyPortableExport(invalid.manifest, invalid.files), "invalid_manifest");

    const invalidHash = fixture();
    invalidHash.manifest.export.artifacts[0]!.sha256 = "not-a-sha";
    expectFailure(() => verifyPortableExport(invalidHash.manifest, invalidHash.files), "invalid_manifest");
  });

  it("uses exact UTF-8 bytes, not characters, for digest and length", () => {
    const { manifest, files } = fixture();
    const report = files[0]!;
    expect(report.bytes.byteLength).toBeGreaterThan(Buffer.from(report.bytes).toString("utf8").length);
    expect(createHash("sha256").update(report.bytes).digest("hex")).toBe(manifest.export.artifacts[0]!.sha256);
    expect(verifyPortableExport(manifest, files).verified).toHaveLength(2);
  });

  it("does not claim artifact authenticity from a self-edited manifest", () => {
    const { manifest, files } = fixture();
    // A party controlling BOTH the bytes and manifest can recompute the unkeyed SHA-256.
    // This verifier guarantees consistency, not publisher authenticity or identity truth.
    const changed = files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }));
    changed[0]!.bytes[0] ^= 1;
    manifest.export.artifacts[0]!.sha256 = createHash("sha256").update(changed[0]!.bytes).digest("hex");
    expect(verifyPortableExport(manifest, changed).status).toBe("trusted_ready");
  });
});
