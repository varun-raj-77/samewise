import { useEffect, useRef, useState } from "react";

import { BrowserExportVerificationError, verifyBrowserExport, type BrowserExportVerification } from "./export-verifier.js";
import "./export-verifier.css";

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_CSV_BYTES = 64 * 1024 * 1024;

export function ExportVerifierWorkspace() {
  const [manifest, setManifest] = useState<File | null>(null);
  const [report, setReport] = useState<File | null>(null);
  const [trusted, setTrusted] = useState<File | null>(null);
  const [verification, setVerification] = useState<BrowserExportVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  useEffect(() => () => { generation.current += 1; }, []);

  function selectFile(value: File | null, update: (value: File | null) => void) {
    generation.current += 1;
    update(value);
    setVerification(null);
    setError(null);
    setBusy(false);
  }

  async function verify() {
    if (!manifest || !report) return;
    const current = ++generation.current;
    setBusy(true);
    setVerification(null);
    setError(null);
    try {
      if (manifest.size > MAX_MANIFEST_BYTES || [report, trusted].some((file) => file && file.size > MAX_CSV_BYTES)) {
        throw new BrowserExportVerificationError("file_too_large", "This local checker supports manifests up to 5 MiB and CSVs up to 64 MiB each.");
      }
      let payload: unknown;
      try { payload = JSON.parse(await manifest.text()); }
      catch { throw new BrowserExportVerificationError("invalid_json", "The selected manifest is not valid JSON."); }
      if (current !== generation.current) return;
      const files = await Promise.all([report, trusted].filter((file): file is File => file !== null)
        .map(async (file) => ({ filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
      if (current !== generation.current) return;
      const result = await verifyBrowserExport(payload, files);
      if (current === generation.current) setVerification(result);
    } catch (failure) {
      if (current === generation.current) {
        setError(failure instanceof BrowserExportVerificationError
          ? failure.message
          : "The files could not be checked on this device. Try again in a secure, modern browser.");
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  return <details className="export-verifier" aria-label="Verify a downloaded export">
    <summary>Verify downloaded files on this device <span>Local integrity check</span></summary>
    <div className="export-verifier-body">
      <p>Check that the downloaded CSV files match their provenance manifest byte for byte. The files are processed in this browser and are not uploaded for verification.</p>
      <div className="export-verifier-fields">
        <VerifierFileField label="Provenance manifest (.json)" inputLabel="Provenance manifest for verification"
          removeLabel="Remove provenance manifest" accept=".json,application/json" file={manifest}
          onSelect={(file) => selectFile(file, setManifest)} />
        <VerifierFileField label="Reconciliation report (.csv)" inputLabel="Reconciliation report for verification"
          removeLabel="Remove reconciliation report" accept=".csv,text/csv" file={report}
          onSelect={(file) => selectFile(file, setReport)} />
        <VerifierFileField label="Trusted merged output (.csv) — if exported" inputLabel="Trusted merged output for verification"
          removeLabel="Remove trusted merged output" accept=".csv,text/csv" file={trusted}
          onSelect={(file) => selectFile(file, setTrusted)} />
      </div>
      <button type="button" className="secondary" onClick={() => void verify()} disabled={busy || !manifest || !report}>{busy ? "Checking files…" : "Check file integrity"}</button>
      {error && <p className="export-verifier-error" role="alert"><strong>Verification failed.</strong> {error}</p>}
      {verification && <div className="export-verifier-success" role="status"><strong>File integrity verified</strong><p>{verification.verified.length} CSV file{verification.verified.length === 1 ? "" : "s"} matched the manifest's SHA-256 hashes, exact byte lengths, canonical filenames, and versioned evidence plan.</p><p>Run: <code>{verification.runId}</code> · Status: {verification.status.replaceAll("_", " ")}</p></div>}
      <p className="export-verifier-caveat">This checks consistency, not who created the files, whether the underlying records are correct, or whether the matches are accurate. A replaced manifest and replaced CSVs can still pass.</p>
    </div>
  </details>;
}


function VerifierFileField({ label, inputLabel, removeLabel, accept, file, onSelect }: {
  label: string;
  inputLabel: string;
  removeLabel: string;
  accept: string;
  file: File | null;
  onSelect: (file: File | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  function remove() {
    if (input.current) {
      input.current.value = "";
      input.current.focus();
    }
    onSelect(null);
  }

  return <div className="export-verifier-field">
    <label>{label}<input ref={input} type="file" accept={accept} aria-label={inputLabel}
      onChange={(event) => onSelect(event.target.files?.[0] ?? null)} /></label>
    {file && <button type="button" className="secondary" onClick={remove}>{removeLabel}</button>}
  </div>;
}
