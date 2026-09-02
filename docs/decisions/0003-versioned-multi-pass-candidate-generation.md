# ADR 0003: Versioned multi-pass candidate generation

- Status: Accepted
- Date: 2026-08-31

## Context

The SW-003 all-pairs scorer requires N×M comparisons. It is useful as a correctness
oracle but cannot be the product candidate path at large row counts. Candidate
reduction is valuable only when true identity pairs survive.

## Decision

Use a local, deterministic Python candidate engine over visible A/B rows,
human-confirmed identity mappings, and explicit versioned config. Five independent
hash/inverted-index passes generate cross-source buckets. Their pair union retains
all blocker and hashed-key provenance. Empty keys are omitted. Oversized keys are
suppressed as whole buckets under measured, versioned limits; no bucket is partially
truncated and no one-to-one assignment is imposed.

Keep hidden truth and corruption provenance in a separate evaluation module loaded
only after generation. Gate deterministic behavior on the checked-in development
snapshot and compare future behavioral changes on generated 1K and 10K fixtures.
Keep all-pairs scoring as an explicit small-fixture oracle. Product requests use
candidate generation before the unchanged baseline scorer.

## Consequences

- Candidate behavior and benchmark reports are reproducible and comparable.
- Candidate recall is measured separately from final record-matching recall.
- Bucket suppression can lose true pairs; affected relationships and miss reasons
  are visible rather than silently truncated.
- The current synthetic fixtures have unusually strong domain evidence. Their 100%
  candidate recall does not establish real-data or 100K-row performance.
- No new dependency, service, queue, model, or assignment algorithm is introduced.
