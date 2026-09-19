# ADR 0012: Dataset-adaptive semantic evidence and deterministic review groups

- Status: Accepted
- Date: 2026-09-19

## Context

The guided workflow already separated identity decisions from survivorship and
served bounded review projections, but field behavior was inferred from labels and
column names. Persistent and source-local identifiers could not be distinguished,
contact people could be treated as entity names, generic fields could receive
incompatible fuzzy comparisons, and the only way to resolve a large review queue
was one case at a time.

A deterministic 8,000 by 8,000 reconstruction reproduced the public workload:
6,178 automatic matches, 1,312 review cases, 510 matcher A-only projections, and
1,822 matcher B-not-auto-linked projections. Of the review cases, 822 had the true pair on top and 490 had
no true candidate. The latter were created by a source-local identifier plus
repeated supporting evidence and did not benefit from human judgment.

An inverse-square-root value-frequency score multiplier was also evaluated. It
reduced held-out evidence scores enough to lower end-to-end recovery materially,
so production score scaling by frequency was rejected.

## Decision

Introduce confirmed-mappings-v3, semantic-mapping prompt/output v3,
candidate-engine-v0.4.0, feature-pipeline-v0.2.0,
explainable-matcher-v0.3.0, matcher-config-v0.3.0, evidence-plan-v1.0.0, and
review-signature-v1.0.0.

The bounded semantic families are persistent identifier, source-local identifier,
entity name/title, contact person, email, phone, domain, address, geography,
categorical, numeric, date/timestamp, free text, and unknown. Human-confirmed
families are authoritative. Legacy mappings remain readable through deterministic
inference; explicit unknown stays conservative.

- Persistent identifiers and domains compare by normalized exact equality.
- Email and phone use deterministic normalization and exact semantic comparison.
- Entity names, contact people, and addresses retain their appropriate existing
  similarity comparators, with contact people carrying supporting semantics.
- Geography, categorical, numeric, dates, free text, and unknown use conservative
  supporting behavior.
- Source-local identifiers are not selected as cross-source identity routes by
  default. An explicit override remains visible and auditable.
- Candidate planning uses semantic route classes and persists the full candidate
  config in the bounded evidence plan.
- Profiles and per-pair evidence classify values as distinctive, repeated, common,
  missing/not applicable, or unknown. Frequency tables are used transiently and
  are not persisted. Frequency classification does not alter production scores.

Build generic review signatures from sorted semantic family, evidence class, and
information class tuples plus margin band, alternative band, collision state, and
strong-contradiction state. Derive review groups from authoritative run state.
Expose bounded summaries and paged previews, never the entire group payload.

Batch SAME and DIFFERENT remain explicit human actions. Every affected candidate
receives its own decision with origin `human_batch_rule`, signature/group ID,
evidence snapshot hash, matcher/feature/candidate/evidence-plan versions, and
timestamp. One undo unit reverses the batch only while downstream dependency
guards permit it.

## Consequences

- The public-style queue falls from 1,312 to 822 by removing 490 no-truth noise
  cases. Candidate recall and automatic precision remain 100%, and all remaining
  cases retain the true candidate on top.
- The 822 remaining cases form three deterministic safe groups. They need preview
  and one explicit decision per group, not 822 individual clicks; no case in this
  fixture remains individual after grouping.
- Frozen-holdout candidate recall remains 98.521047%, end-to-end recovery improves
  from 98.293515% to 98.521047%, and false automatic and hard-negative automatic
  matches remain zero. Exact semantic email behavior is more conservative, so
  automatic matches decrease and more retained truth is routed to review.
- Cross-domain gates pass separately for organizations, people, products,
  facilities, sparse legacy data, and deliberately low-information data. The
  low-information case performs no automatic matches and explicitly abstains.
- Frequency-aware production scoring remains deferred. Any future multiplier must
  pass the frozen holdout and cross-domain gates as a separate versioned decision.
- No clustering, global assignment, embeddings, model training, infrastructure,
  or AI row decisions are introduced.
