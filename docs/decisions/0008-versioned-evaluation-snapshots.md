# 0008 — Versioned evaluation snapshots and isolated truth APIs

## Status

Accepted for SW-009.

## Decision

Evaluation is a product trust surface, but it remains outside normal reconciliation
state. The Python evaluation command runs visible candidate generation and scoring
before opening hidden fixture truth. It writes content-addressed, immutable
`evaluation-snapshot-v1.0.0` artifacts and separately paged error artifacts.

The API reads and validates checked-in snapshots through dedicated `/api/evaluations`
routes. It never adds fixture truth or benchmark errors to `RunView`. Missing
evaluation artifacts do not prevent product run creation or matching.

`SYNTHETIC_GROUND_TRUTH` and `HUMAN_REVIEW_LABELS` are distinct source types. Human
review evidence is a nonrepresentative reviewed subset and retains the score,
evidence, system proposal, matcher version, candidate-engine version, and decision
time that the reviewer actually saw.

Direct deltas require the same source type and identity, dataset fingerprints,
candidate engine/configuration, and compatible evaluator semantics. Otherwise the
comparison says “Not directly comparable” and emits no deltas.

## Consequences

- Matcher and candidate behavior are unchanged.
- Changing evaluator semantics requires an evaluation-version change and new
  snapshots rather than mutation of historical evidence.
- Quality gates are explicit, deterministic evidence. They do not declare a global
  winner or forbid every tradeoff.
- Human labels are not training input in this milestone.
- Local file artifacts remain sufficient; no database, worker, or queue is added.
