# SW-027 — Collision-aware review of a contested Dataset B record

## Objective

SW-026's measured synthetic duplicate-heavy case put 87 A rows in review; 72 of the 85 locally deferred top candidates carried Python's collision hint, while the final one-to-one selector added two additional shared-B cases. The high-value UX intervention is a **fast, accurate view of every retained Dataset A contender for one chosen B**, not a lower threshold or a forced winner.

The existing review groups collect cases with similar evidence signatures. This feature adds an *exact shared-identity context* opened from the current candidate's collision warning. It does not claim all matching pattern-group members belong to the same entity.

## Scope

- `GET /api/runs/:runId/collision-context?bRowId=...&offset=0&limit=20` projects every retained candidate edge to the requested B (including candidate alternatives), deterministically ordered by candidate rank, descending score and stable A/candidate ID.
- The response contains B identity fields from confirmed mapped columns, distinct A contender count, a current B claimant **if there is an effective identity link**, and a bounded page of A contenders. Each item includes only mapped identity fields, existing per-candidate evidence summary, rank/score, human-decision status, and whether its A has already been linked elsewhere.
- A contender is not labeled as an identity match unless the **existing version-pinned effective-link selector** or a human SAME decision actually supports it. Being listed as a contender never implies or persists a decision.
- Reviewers explicitly open *all* candidates for that B from the collision warning, navigate bounded pages and inspect another A's full side-by-side evidence even if that A is off the current review queue page. Existing guarded SAME/DIFFERENT, undo and field-resolution actions remain solely in the individual review flow.
- The collision-context API is read-only, accepts a bounded B identifier and paginated values, returns 400 for invalid inputs and 404 for nonexistent retained candidates, and never exposes full A/B source records in its group projection. Individual candidate detail remains a separate intentionally requested action.
- Lazy loading, error/retry, cache invalidation after run review-state changes and accessible controls keep the UI responsive while a large collision group is inspected.

## Acceptance and tests

1. API regression tests cover two competing A rows for one B, deterministic paging, ID-only/mapped-field projection, claimed-B provenance after human SAME, rejection on competing SAME, then DIFFERENT classification, invalid pagination, and nonexistent B context.
2. UI tests cover lazy expansion, choosing off-page candidate detail without making a decision, bounded pagination, reloading after run revision changes, and recovery from fetch failure.
3. Existing API, review keyboard, human decision, undo, survivorship, SW-022/SW-024/SW-025/SW-026 benchmark and production web build checks stay green.
4. **No matcher version, thresholds, candidate-generation strategy, global assignment, human decisions, source rows or exports are changed.** No automatic mass resolution and no true-identity certainty inferred from a high candidate score.
5. Avoid heavy infrastructure, production tests, manual deployments or access to hosting configuration.

## Risks and exclusions

This first slice groups by **one exact B ID**, not transitive graph connected components spanning multiple Bs. It does not build an arbitrary many-to-many review editor, graph solver, or batch SAME action. It is intentionally limited to read-only context and existing human identity decisions. Its reviewed-case throughput gains are a UX hypothesis, **not an invented measured performance claim**. Measure review speed/accuracy with realistic sessions before asserting improvement.

It also does not solve the underlying cardinality problem: duplicated canonical entities can correspond to multiple real source occurrences while the product currently enforces one-to-one assignments. That remains an explicit future policy decision, not something this UI silently works around.
