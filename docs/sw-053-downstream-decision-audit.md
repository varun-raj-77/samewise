# SW-053 — Downstream identity decision audit for address rescue

## Question

SW-052 showed that exact normalized street+locality blocking can recover synthetic true pairs missing after complete organization-name changes, but it also adds false candidate pairs in shared buildings. Does the **unchanged v0.3 matcher** actually surface those recovered pairs to a reviewer? Does the additional candidate set change auto-matches, one-to-one collision warnings, top-ranked choices, or review demand?

Candidate recall alone cannot answer those questions. Evaluate scoring and result assembly before considering any product blocker.

## Controlled comparison

This audit starts from the unchanged SW-052 truth-separated synthetic fixture, retaining its deterministic A/B row IDs, hidden one-to-one truth, mapped names, streets and geography. Both the baseline candidate engine and the address-only candidate probe are run **without truth labels**.

1. Score the unchanged baseline candidates using the production score_generated_candidates and the frozen default MatcherConfig.
2. Score **only** incremental address-probe candidate pairs with score_candidate using the same three confirmed semantic identity mappings, weights, and decision rules.
3. Mark incremental pairs with a **distinct evaluation-only blocker provenance label**, not a falsely attributed product blocker.
4. Call the actual build_match_result for baseline and combined scenarios, without changing thresholds, scoring, alternative cutoffs, collision checks or one-to-one policy.
5. Only after both result sets exist, compare against complete synthetic truth. Output true and false top-ranked pairs, correct/incorrect auto-matches, review-row counts, displayed alternatives, missed displayed truth, and B collision warnings.

The cached scorer classifies normalized-field frequencies; the direct scorer does not use that cache. Their current scoring weights are unchanged by those informational frequency classes, but this limitation must be reevaluated if frequency-weighted scoring is ever enabled.

**Important:** The current build_match_result collision flag is based on more than one A choosing the same top B; it is **not a general global one-to-one assignment solver**. This audit measures the current behavior, not a hypothetical stronger assignment rule.

## Verification and scope

- Run multi-seed 1K and 10K controlled comparisons with the proposed pass's strict (4 pair) and default (100 pair) bucket caps.
- Use regression tests to enforce identical baseline results across cap changes, stable truth isolation, never treating missing auto-match denominators as perfect precision, and never describing candidates as completed identity decisions.
- CI also repeats the existing SW-022/SW-024/SW-025/SW-026 matcher gates, SW-052 benchmark, standard Python/TypeScript validation and web build.
- No change to production blocking, matcher configuration, API, run manifests, identity decisions, survivorship or source datasets.
- Do not interpret synthetic outcomes as calibrated customer-data performance. Scenario construction is inherited from SW-052; multiple seeds do not constitute a genuinely independent real-data holdout.

## Decision gate

A product blocker proposal needs all of the following: (a) candidate recall improves on independently designed hidden-truth adversarial fixtures, (b) incorrect auto-match rate does not rise unacceptably, (c) review workload and collision demand stay manageable, (d) precision/recall tradeoffs and bucket suppression are documented, (e) versioned provenance and deterministic replay, and (f) tests for multigeography mappings, moved businesses, shared addresses, and identity-vs-survivorship separation.

Neither a synthetic recall gain nor an unchanged count of false automatic decisions alone authorizes enabling an address-only blocker. SW-053 remains an **evaluation-only stacked change** on SW-052 until independently reviewed and verified.
