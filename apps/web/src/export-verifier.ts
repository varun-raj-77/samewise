import {
  RECONCILIATION_EXPORT_VERSION,
  RunManifestSchema,
  TRUSTED_EXPORT_VERSION,
} from "@samewise/contracts";

export class BrowserExportVerificationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BrowserExportVerificationError";
  }
}

export interface BrowserExportFile {
  filename: string;
  bytes: Uint8Array;
}

export interface BrowserExportVerification {
  runId: string;
  status: "matched" | "identity_unresolved" | "conflicts_unresolved" | "trusted_ready";
  verified: { kind: "reconciliation_report" | "trusted_merged_output"; filename: string; byteLength: number }[];
}

type DigestFn = (bytes: Uint8Array) => Promise<string>;

function insist(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new BrowserExportVerificationError(code, message);
}

async function browserDigest(bytes: Uint8Array): Promise<string> {
  insist(typeof crypto !== "undefined" && Boolean(crypto.subtle), "crypto_unavailable", "Secure browser cryptography is unavailable.");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
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

/** Local consistency check only; the unsigned manifest cannot authenticate its publisher. */
export async function verifyBrowserExport(
  manifestInput: unknown,
  files: BrowserExportFile[],
  digest: DigestFn = browserDigest,
): Promise<BrowserExportVerification> {
  const parsed = RunManifestSchema.safeParse(manifestInput);
  insist(parsed.success, "invalid_manifest", "The manifest does not match the supported versioned format.");
  const manifest = parsed.data;
  const token = safeRunToken(manifest.run.runId);
  const expected = {
    reconciliation_report: { filename: `samewise-${token}-reconciliation.csv`, version: RECONCILIATION_EXPORT_VERSION },
    trusted_merged_output: { filename: `samewise-${token}-trusted-merged.csv`, version: TRUSTED_EXPORT_VERSION },
  } as const;
  const declared = manifest.export.artifacts;
  const kinds = declared.map((artifact) => artifact.kind);

  insist(new Set(kinds).size === kinds.length, "duplicate_artifact_kind", "The manifest contains a duplicate artifact kind.");
  insist(kinds.includes("reconciliation_report"), "missing_reconciliation", "The manifest does not declare a reconciliation report.");
  const trusted = kinds.includes("trusted_merged_output");
  insist(trusted === (manifest.run.status === "trusted_ready"), "readiness_mismatch", "The trusted CSV declaration contradicts the recorded readiness.");
  if (trusted) {
    insist(
      manifest.identity.pendingCount === 0 && manifest.identity.deferredCount === 0
        && manifest.survivorship.unresolvedConflictCount === 0,
      "unresolved_trusted_run",
      "The manifest declares trusted output with unresolved reviews.",
    );
  }

  const planBytes = new TextEncoder().encode(JSON.stringify(canonicalize(manifest.candidateGeneration.evidencePlan)));
  insist(
    await digest(planBytes) === manifest.candidateGeneration.evidencePlanSha256,
    "evidence_plan_mismatch",
    "The evidence-plan digest does not match the manifest.",
  );

  for (const artifact of declared) {
    insist(
      artifact.version === expected[artifact.kind].version && artifact.filename === expected[artifact.kind].filename,
      "artifact_metadata_mismatch",
      "The artifact filename or version does not match this run.",
    );
  }

  insist(files.length === declared.length, "file_set_mismatch", "Select exactly the CSV files declared in the manifest.");
  const byName = new Map<string, Uint8Array>();
  for (const file of files) {
    insist(file && typeof file.filename === "string" && file.filename.length > 0 && file.bytes instanceof Uint8Array, "invalid_file_input", "A selected file is invalid.");
    insist(!byName.has(file.filename), "duplicate_file", "The same filename was supplied more than once.");
    byName.set(file.filename, file.bytes);
  }

  const verified: BrowserExportVerification["verified"] = [];
  for (const artifact of declared) {
    const bytes = byName.get(artifact.filename);
    insist(bytes !== undefined, "missing_file", "Selected CSV filenames do not match the manifest.");
    insist(bytes.byteLength === artifact.byteLength, "byte_length_mismatch", "A CSV byte length differs from the manifest.");
    insist(await digest(bytes) === artifact.sha256, "sha256_mismatch", "A CSV SHA-256 hash differs from the manifest.");
    verified.push({ kind: artifact.kind, filename: artifact.filename, byteLength: artifact.byteLength });
  }

  return { runId: manifest.run.runId, status: manifest.run.status, verified };
}
