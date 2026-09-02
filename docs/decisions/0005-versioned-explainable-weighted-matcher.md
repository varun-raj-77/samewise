# ADR 0005: Versioned explainable weighted matcher with frozen holdout evaluation

- Status: Accepted
- Date: 2026-08-31

## Context

The SW-003 scorer averaged exact equality and one generic string-similarity value.
It did not distinguish strong identifier conflicts, expose blocker provenance, or
support a disciplined tune/holdout quality evaluation. Candidate-engine-v0.2.0
now bounds the pairs that reach scoring, so downstream quality must also preserve
the candidate-recall ceiling.

## Decision

Use `feature-pipeline-v0.1.0` and `explainable-matcher-v0.2.0` as the default
product scorer. The feature pipeline consumes only human-confirmed identity
mappings and emits bounded visible-data features, evidence classes, deterministic
explanation codes, weights, and positive/conflict contributions. The match score
is the bounded net weighted evidence divided by total configured identity weight.
Missing values contribute zero while remaining in the fixed denominator, so they
cannot raise a score. Strong phone, email, and domain conflicts block auto-match
but are not treated as authoritative identity truth.

Keep collision, contradiction, threshold, margin, and alternative rules in the
frozen `matcher-config-v0.2.0`. Select thresholds on the fixed 1,200-entity tuning
fixture, freeze the config, and only then evaluate the separately seeded 1,200-
entity holdout. Evaluation loads hidden truth only after visible candidate
generation and scoring. Keep `baseline-matcher-v0.1.0` runnable on the identical
candidate set for comparison.

Python's standard-library `SequenceMatcher` plus Samewise-owned token functions
remain sufficient for this version. RapidFuzz was considered, but current
candidate volumes do not justify a new dependency solely for a faster fuzzy
primitive, and the required feature semantics remain Samewise-owned either way.
No RapidFuzz quality or speed comparison is claimed.

## Consequences

- Every score is reconstructable from stored field contributions and total weight.
- Match scores are evidence scores, not calibrated probabilities.
- Candidate misses, below-review-threshold true links, and post-score alternative
  losses are reported separately; end-to-end recovery is asserted not to exceed
  candidate recall.
- Auto-matches remain system proposals and never choose survivorship values.
- Synthetic holdout performance is evidence for this fixed fixture, not a claim
  about real customer data or calibrated match likelihood.
- Global assignment, learned models, embeddings, and new infrastructure remain
  deferred.
