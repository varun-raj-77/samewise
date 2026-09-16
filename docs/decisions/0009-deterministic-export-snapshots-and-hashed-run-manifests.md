# ADR 0009: Deterministic export snapshots and hashed run manifests

- Status: Accepted
- Date: 2026-09-16

## Context

Reconciliation and trusted CSVs could leave the application, but no portable
artifact described the authoritative state or verified the exact bytes. Persisting
exports or freezing whole runs would add infrastructure beyond measured needs.

## Decision

Derive a synchronous, deterministic export snapshot from current process-local run
state. Generate reconciliation and, when the existing readiness gate passes,
trusted CSV bytes once per request. Hash those bytes with SHA-256 and emit a
versioned JSON manifest containing provenance and artifact metadata. Do not include
an export-time clock and do not self-hash the manifest.

Keep ordinary run provenance separate from synthetic Evaluation truth. Represent
unavailable candidate configuration and unattached evaluation snapshots explicitly.
Do not persist, sign, stream, or ZIP artifacts in this milestone.

## Consequences

- Unchanged authoritative state produces byte-identical artifacts.
- A decision or resolution intentionally changes the snapshot descriptor and output.
- Manifest plus reconciliation CSV supports provenance tracing without duplicating
  every detail in every trusted-output cell.
- Process restart still removes workflow state, and downloaded artifacts are not
  server-managed after delivery.
- Artifact shape/semantics have independent versions; matcher, candidate engine,
  and evaluator versions are unchanged.
