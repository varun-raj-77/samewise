# SW-026 — Duplicate-aware review-demand analysis

## Objective

SW-025 measured an increase from **15.53%** review rate on the moderate synthetic cohort to **44.16%** in the duplicate-dense cohort. This milestone identifies the actual source of that review work **without modifying Python matching, thresholds, or the version-pinned SW-021 one-to-one assignment policy**.

## Diagnostic inputs, privacy, and reproducibility

`pnpm benchmark:sw026` reuses exactly the existing SW-025 Python fixture generator, candidate engine, matcher, mappings, and frozen seeds in an opt-in diagnostic mode. It produces a separate `evaluation/reports/sw-026/latest-ci.json`. The normal `pnpm benchmark:sw025` mode remains unchanged.

For each synthetic cohort, score and candidate generation run **before hidden canonical-entity truth is read**. The retrospective diagnostic uses only row IDs, candidate ranks/bands/flags, and fixture canonical-entity IDs. No uploaded source fields appear in the output or review examples.

## Mutually exclusive review reasons

Review rows are counted precisely once under a priority classification. In order:

1. Multiple rank-one auto proposals for a single A row (malformed/ambiguous proposal).
2. Rank-one pair locally marked `needs_review` by the matcher.
3. Rank-one auto pair with an explicit matcher collision hint.
4. Rank-one auto pair sharing its B with at least one other A candidate (global collision gate).
5. No rank-one pair retained for this A.
6. Other assignment guard (fallback).

**Important:** the reason classes are diagnostic priorities, not mutually exclusive physical properties. A locally uncertain pair may also have global B contention. Therefore a primary reason count does not demonstrate that removing a different safeguard would automatically link that row.

A second independent decomposition groups review rows by hidden truth class:

- Unique true cross-source identity (one A and one B for a canonical entity).
- Duplicate cross-source identity (more than one A or more than one B for a canonical entity).
- No true cross-source identity (review would be a false positive if linked).

A third, also mutually exclusive, assigns where the **true correspondence** is in the matcher evidence: correct top-ranked pair, lower-ranked retained true alternative, generated but not retained true pair, truth pair never generated, or no truth match. Cross-tabulations of reason × truth class and reason × truth evidence provide counts, not unvalidated predictions about safety.

A further overlapping **matcher gate** breakdown inspects the configured score threshold, minimum runner-up margin, strong contradiction, and matcher's own collision flag among locally deferred top pairs. These flags may co-occur and cannot be summed; the matcher does not expose the exact agreement-field count through the public candidate contract, so it is not fabricated.\n\nThe diagnostics also enumerate A rows with **no retained candidates** separately, to avoid conflating unmatched records with queued human reviews. Every category reconciles to exactly the production selector's candidate-bearing review count. Any mismatch fails the benchmark.

## Measured CI #282 results — actual matcher on synthetic data

[GitHub Actions #282](https://github.com/varun-raj-77/samewise/actions/runs/40381812745) ran the actual candidate generator and matcher against all three previously frozen synthetic input cohorts. The observed JSON (including identical input SHA-256 digests) is preserved at [`observed-ci-282.json`](../evaluation/reports/sw-026/observed-ci-282.json).

| Mutually exclusive main review cause | Moderate | High corruption | Duplicate-dense |
|---|---:|---:|---:|
| Matcher classified top pair `needs_review` | 25 | 58 | 85 |
| Final selector blocked an `auto_match` because another A retained the B | 0 | 0 | 2 |
| **All human-review cases** | **25** | **58** | **87** |
| Reviewed A rows with duplicated canonical entities | 16 | 37 | 82 |
| Reviewed A rows with correct top-ranked pair according to truth | 21 | 54 | 86 |

**Critical second layer:** many locally classified `needs_review` pairs already carry the matcher's own collision flag. The following independent flags **overlap** and must not be added together:

| Visible matcher gate among locally deferred top pairs | Moderate | High corruption | Duplicate-dense |
|---|---:|---:|---:|
| Matcher collision flag true | 17 | 35 | **72** |
| Top score below configured 0.50 auto threshold | 4 | 10 | 1 |
| Runner-up margin below configured 0.04 minimum | 4 | 6 | 18 |
| Strong contradiction flag | 8 | 25 | 6 |

This distinction matters: **72 of the 85 locally abstained duplicate-heavy cases already involve the Python matcher's collision safeguard**. It is wrong to conclude that the primary problem is simply low scores, or that only two of the 87 reviewed records involve duplicate-B competition. The final global selector adds two additional shared-B review cases, while the matcher has already routed most contested top choices to human review.

The matcher currently marks a top choice as colliding when more than one A row prefers the same B at or above review threshold. That collision is **not the same as proving both A records refer to the same canonical entity**. The actual results show a need to distinguish repeated source occurrences, uncertain cross-record competition and legitimate multi-occurrence ground truth before declaring any review automatically unnecessary.

Likewise, **86/87 correct top candidates retrospectively** cannot justify accepting them automatically, because hidden truth is unavailable to the running matcher and one-to-one uniqueness still constrains assignments. These are synthetic observations, not representative business outcomes.

**Engineering decision:** Preserve both the matcher-level collision review safeguard and the final unique-B invariant. Prioritize a more informative *collision-cluster review UX and diagnostic evidence* before changing scoring or automatically resolving competing identities. Revisit a more efficient selection policy only with version-pinned, independent duplicate-aware labels and a demonstrated precision-versus-review advantage.

## Why this is useful

- If local `needs_review` dominates on duplicated identities, reducing review burden likely requires evidence/calibration work and clarity on cardinality, not simply weakening global B uniqueness.
- If shared-B automatic contention dominates, investigate one-to-one assignment policy and safe graph-level abstention.
- If many review rows have correct top candidates but also multiple true occurrences, **do not call them needless reviews**: truth is unavailable to the matcher and a pair can be correct but globally ambiguous.
- If generated pairs disappear during scoring/alternative retention, study stage-specific pruning, independent from review decisions.

## Tests, acceptance, and exclusions

- Unit tests cover real duplicates, exact local abstention, shared-B contention, explicit collision flags, malformed multiple tops, correct retained alternatives, true pairs lost between generation and retention, true links absent from blocking, and no-candidate A rows.
- CI runs `pnpm verify`, unchanged SW-022/SW-024/SW-025 benchmarks, new SW-026 diagnostic mode, and the web production build.
- Evaluate each cohort on actual production Python-generated candidate graphs; synthetic ground truth is post-hoc evidence, **not human-adjudicated, representative real-world performance or calibrated probabilities**.
- No identity/survivorship changes, no new AI calls, no forced link selection, no matcher score tuning, no hidden overwrite of existing judgments, no production tests, manual deployment, or Railway access.

## Follow-on decision

Base any SW-027 intervention on observed root causes and separate fresh labeled fixtures, while measuring auto precision, candidate recall and review rate jointly. Avoid tuning to these now-observed SW-025/SW-026 cohorts.
