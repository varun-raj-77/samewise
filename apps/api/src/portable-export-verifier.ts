import { createHash } from "node:crypto";

import {
  RECONCILIATION_EXPORT_VERSION,
  RUN_MANIFEST_VERSION,
  RunManifestSchema,
  TRUSTED_EXPORT_VERSION,
} from "@samewise/contracts";

export const PORTABLE_EXPORT_VERIFIER_VERSION = "portable-export-verifier-v1.0.0" as const;

export class PortableExportVerificationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PortableExportVerificationError";
  }
}

export interface PortableExportFile {
  filename: string;
  bytes: Uint8Array;
}

export interface PortableExportVerification {
  verifierVersion: typeof PORTABLE_EXPORT_VERIFIER_VERSION;
  runId: string;
  manifestVersion: typeof RUN_MANIFEST_VERSION;
  status: "matched" | "identity_unresolved" | "conflicts_unresolved" | "trusted_ready";
  verified: { kind: "reconciliation_report" | "trusted_merged_output"; filename: string; sha256: string; byteLength: number }[];
}

function insist(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new PortableExportVerificationError(code, message);
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function safeRunToken(runId: string): string {
  return runId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.{2,}/g, ".").slice(0, 120) || "run";
}

/**
 * Offline byte-integrity and manifest-consistency verification.
 * This does NOT authenticate who produced a manifest or establish matching correctness.
 * The original CSV uploads and authoritative workflow snapshot are not available here.
 */
export function verifyPortableExport(manifestInput: unknown, files: PortableExportFile[]): PortableExportVerification {
  const result = RunManifestSchema.safeParse(manifestInput);
  insist(result.success, "invalid_manifest", "Manifest does not satisfy the versioned run-manifest contract.");
  const manifest = result.data;
  const token = safeRunToken(manifest.run.runId);
  const expectedName = {
    reconciliation_report: `samewise-${token}-reconciliation.csv`,
    trusted_merged_output: `samewise-${token}-trusted-merged.csv`,
  } as const;
  const expectedVersion = {
    reconciliation_report: RECONCILIATION_EXPORT_VERSION,
    trusted_merged_output: TRUSTED_EXPORT_VERSION,
  } as const;

  const declared = manifest.export.artifacts;
  const kinds = declared.map((artifact) => artifact.kind);
  insist(new Set(kinds).size === kinds.length, "duplicate_artifact_kind", "Manifest repeats an artifact kind.");
  insist(kinds.includes("reconciliation_report"), "missing_reconciliation", "Manifest must include a reconciliation report.");
  const trusted = kinds.includes("trusted_merged_output");
  insist(trusted === (manifest.run.status === "trusted_ready"), "readiness_mismatch", "Trusted artifact presence does not match run readiness.");
  if (trusted) {
    insist(
      manifest.identity.pendingCount === 0 && manifest.identity.deferredCount === 0
        && manifest.survivorship.unresolvedConflictCount === 0,
      "unresolved_trusted_run",
      "Trusted output is declared while identity or field review remains unresolved.",
    );
  }

  insist(
    sha256(JSON.stringify(canonicalize(manifest.candidateGeneration.evidencePlan)))
      === manifest.candidateGeneration.evidencePlanSha256,
    "evidence_plan_mismatch",
    "The recorded evidence plan does not match its digest.",
  );

  for (const artifact of declared) {
    insist(
      artifact.version === expectedVersion[artifact.kind] && artifact.filename === expectedName[artifact.kind],
      "artifact_metadata_mismatch",
      "Artifact version or canonical filename does not match the declared run.",
    );
  }

  insist(Array.isArray(files) && files.length === declared.length, "file_set_mismatch", "Supply exactly the artifacts declared in the manifest.");
  const fileByName = new Map<string, Uint8Array>();
  for (const file of files) {
    insist(
      file && typeof file.filename === "string" && file.filename.length > 0 && file.bytes instanceof Uint8Array,
      "invalid_file_input",
      "Each file must have a filename and raw byte content.",
    );
    insist(!fileByName.has(file.filename), "duplicate_file", "The same artifact filename was supplied twice.");
    fileByName.set(file.filename, file.bytes);
  }
  const verified: PortableExportVerification["verified"] = [];
  for (const artifact of declared) {
    const bytes = fileByName.get(artifact.filename);
    insist(bytes !== undefined, "missing_file", "An artifact filename is missing or does not match the manifest.");
    insist(bytes.byteLength === artifact.byteLength, "byte_length_mismatch", `Artifact byte length differs: ${artifact.filename}`);
    insist(sha256(bytes) === artifact.sha256, "sha256_mismatch", `Artifact SHA-256 differs: ${artifact.filename}`);
    verified.push({ kind: artifact.kind, filename: artifact.filename, sha256: artifact.sha256, byteLength: artifact.byteLength });
  }
  return {
    verifierVersion: PORTABLE_EXPORT_VERIFIER_VERSION,
    runId: manifest.run.runId,
    manifestVersion: RUN_MANIFEST_VERSION,
    status: manifest.run.status,
    verified,
  };
}
