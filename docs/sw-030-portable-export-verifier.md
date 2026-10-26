# SW-030 — Portable export integrity verifier

## Objective

Allow recipients of a Samewise run export to verify locally that the downloaded CSV
files still match the manifest **byte for byte**. SW-010 hashes artifacts but did not
provide a portable, independently runnable verification path.

This is an *integrity/consistency check*, not a digital signature, proof of source
authenticity, audit of matching correctness, or assertion that human decisions are true.

## Scope

- Offline, opt-in `pnpm verify:export -- <manifest.json> <reconciliation.csv> [trusted-merged.csv]`.
- Validates the existing versioned manifest contract, exact artifact kind/version/name
  for that run, SHA-256 over raw bytes, byte length, unique complete artifact set,
  evidence-plan digest and trusted readiness consistency.
- Supports both an ordinary reconciliation-only run and a trusted-ready run.
- No upload, network call, file mutation, collection of record values, or live test.
- No change to matching/assignment thresholds, run data, workflow decisions,
  existing CSV/manifest producer, export endpoints or deployment configuration.

## Acceptance criteria

1. Verifying a genuine artifact snapshot produced by `buildExportSnapshot` succeeds
   both with and without a trusted merged CSV.
2. A one-byte alteration, truncation, missing/extra/renamed file, duplicate artifact
   kind, invalid manifest/version or readiness inconsistency fails closed.
3. Verification uses raw UTF-8 *bytes*, including non-ASCII content, and is stable
   across caller file ordering.
4. A tampered evidence plan with an unchanged digest fails.
5. No source rows, secret values or file contents are printed by the CLI.
6. Existing repo verification and matcher benchmarks stay green.

## Important boundaries

- Anyone capable of replacing both the manifest and artifact bytes can compute new
  SHA-256 hashes. This check **does not authenticate the publisher**; that requires
  separately established signing/trust infrastructure. No signatures are added here.
- The exported source fingerprints, authoritative workflow snapshot digest,
  assignment/version claims and human decision summaries are **recorded claims**:
  they cannot be independently recomputed from this limited portable bundle alone.
  Uploads and the full authoritative state are deliberately not bundled.
- The command reads only paths explicitly passed by the operator and prints a
  compact success summary or error code, never CSV rows. Protect downloaded files
  according to their sensitivity and retention policy.

## Verification

`apps/api/tests/portable-export-verifier.test.ts` exercises real producer output,
readiness, exact bytes, Unicode, file-set failures, tampered metadata and evidence
plans. It also demonstrates that a self-edited manifest and CSV may still pass:
this deliberate test prevents an accidental authenticity claim.

## Exclusions

No automatic signing service, object storage, scheduled retention/deletion, UI
rearchitecture, external deployment, production tests, or new metrics.
