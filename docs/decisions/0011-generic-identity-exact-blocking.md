# ADR 0011: Mapping-specific exact blocking for generic identity evidence

- Status: Accepted
- Date: 2026-09-17

## Context

Candidate engines through `candidate-engine-v0.2.0` emitted blocking keys only for
recognized semantic field kinds. A confirmed identity mapping classified as
`other`, such as `stable_id` to `stable_id`, therefore contributed no candidate
even when both normalized non-empty values were exactly equal.

## Decision

Introduce `candidate-engine-v0.3.0`. Generic mappings with role `identity` emit an
exact key under `exact_strong_v1` using the mapping ID and normalized value. The
key is mapping-specific, empty values are omitted, and the existing inverted-index
bucket suppression limits remain authoritative. Comparison mappings never emit
candidate keys. Generic exact equality creates candidate membership only; scoring,
minimum agreement, collision, contradiction, margin, and threshold rules are
unchanged.

Keep the v0.1 and v0.2 candidate configs runnable with their historical membership
semantics. Do not rewrite their committed benchmark, evaluation, or frozen config
artifacts. The new `matcher-v0.2.0-candidate-v0.3.0.json` composition preserves the
unchanged matcher policy while aligning current product runtime provenance with
candidate-engine v0.3. The matcher rejects an explicitly supplied candidate config
whose version does not match its frozen provenance.

## Consequences

- Confirmed generic identifiers can reach scoring without fuzzy generic matching.
- Equal values from unrelated generic mappings cannot form cross-field candidates.
- Large duplicate generic-ID buckets are suppressed rather than expanded.
- Historical reports remain attributable to the engine version that generated them.
