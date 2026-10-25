# SW-022 — Held-out impact of enforcing one-to-one identities

## Objective

Quantify the correctness/review burden of SW-021 **without** changing matching algorithms, tuning thresholds on holdout data, or presenting invented precision/recall/runtime metrics.

## Frozen input and paired policies

`pnpm benchmark:sw022` runs the **current Python matcher exactly once per fixture** on checked-in CSVs using the existing confirmed semantic mapping configuration. It evaluates two policy functions against **the same retained matcher output**:

- **Legacy, before SW-021**: rank-1 candidates with `band: auto_match` were considered effective regardless of cross-A competition for a B row. Product export previously suppressed repeated A rows, but did not suppress repeated B IDs.
- **One-to-one, SW-021**: actual imported `automaticIdentityCandidateIds` product selector, requiring a unique B owner among retained candidates, an unambiguous rank-1 auto score per A, and no explicit `collision` hint.

The policies are not different ML models. The experiment is paired on a fixed matcher output; it measures *assignment policy effects only*, not a matcher-version comparison.

Frozen synthetic development fixture `organizations-dev-v1` is a smoke/check case. A separately seeded, weak-identifier `organizations-matcher-holdout-1200-v1` fixture measures held-out effects. The latter has duplicate occurrences; consequently truth may contain multiple legitimate cross-source pairs for a given source row or canonical entity. Such truth is preserved rather than coerced into one-to-one labels. These are **synthetic** reports, not real user reconciliation metrics.

## Metrics and denominators

- **Auto-match precision**: automatically selected pairs that share a canonical entity ID / automatically selected pairs. Report `null` if the policy produces no auto-matches; never claim a perfect precision from a zero denominator.
- **Auto-match recall per matchable A**: true auto-selected pairs / A rows with one or more real links in B. This is a unique-A assignment outcome, not pairwise true-link recall when there are duplicates.
- **Review rate (all A)**: A rows with at least one retained candidate but no automatic link / all A rows. `Source-only` A rows with no candidate are not routed to review.
- **Review rate (matchable A)**: matchable A rows with retained candidates and no automatic link / matchable A rows.
- **Retained candidate pair recall**: true cross-source pairs still present in the *final retained* matcher alternatives / all true cross-source pairs. This is **not** the upstream blocker-stage candidate recall. As SW-021 applies only after matching, it cannot modify either retained or upstream candidate recall. Verify the invariance, while not claiming a measured upstream candidate recall.
- **Retained pair reduction fraction**: `1 - final_retained_pairs / (A_count × B_count)`. Distinct from pre-scoring candidate reduction.
- **Conflicting B claims**: excess automatically assigned A claims to the same B row. Product policy must yield zero.
- **Correct/incorrect auto pairs routed to review**: the measured true and false auto delta. Losing genuine automatic links to review is a **cost**, even when false positives also decrease.
- **Runtime**: Python matcher subprocess wall clock once per fixture; baseline/one-to-one selection median in-process time over 51 trials (5 warmup). Measured on the GitHub runner, not production SLA or memory benchmark. Selector timing does not include UI, database, full matcher, persistence, or export.

Reported input fingerprint SHA-256s cover both visible CSVs, held-out truth and frozen mapping config. Truth is never passed to the matcher process.

## How to reproduce and inspect

```sh
pnpm install --frozen-lockfile
uv sync --project services/matcher --locked
pnpm benchmark:sw022
```

The script writes `evaluation/reports/sw-022/latest-ci.json` in the local working tree and prints the same JSON to CI logs. Results are generated, not hand-entered. No network calls, hosted user records, model API keys, or real dataset uploads are needed.

CI runs `pnpm verify`, the benchmark, and the production web build. The benchmark fails closed if A/B truth identifiers are malformed, candidate pairs are duplicated, the current selector produces duplicate B claims, or the current selector increases false automatic matches relative to the legacy selection.

## Observed reproducible CI run — synthetic holdout

[CI run #168](https://github.com/varun-raj-77/samewise/actions/runs/40161197358) executed the current matcher and both assignment policies. The unedited, machine-generated JSON is preserved at [`evaluation/reports/sw-022/observed-ci-168.json`](../evaluation/reports/sw-022/observed-ci-168.json).

| Measure | Frozen legacy | SW-021 one-to-one | Delta |
|---|---:|---:|---:|
| Heldout A rows | 1,044 | 1,044 | — |
| Heldout B rows | 1,044 | 1,044 | — |
| True automatically linked pairs | 169 | 89 | **−80** |
| False automatically linked pairs | 0 | 0 | 0 |
| Auto-match precision | 100% (169/169) | 100% (89/89) | 0 pp |
| A rows sent to review | 769 | 849 | **+80** |
| Review rate, all A rows | 73.66% | 81.32% | **+7.66 pp** |
| Review rate, matchable A rows | 79.37% | 88.69% | **+9.32 pp** |
| Duplicated B automatic claims | 0 | 0 | 0 |
| Final-retained candidate true-pair recall | 866/879 = 98.52% | same | unchanged |
| In-process selector median (51 trials) | 0.022 ms | 0.118 ms | +0.096 ms |

The development smoke fixture (23 A rows, 22 B rows) showed no selection difference: both policies auto-linked 12 correct pairs and sent 7 A records to review. Its final-retained candidate recall was 21/21.

For the holdout, the Python subprocess matcher consumed **2,370.59 ms wall clock** on the CI runner. Selector timing is a separate microbenchmark (not an end-to-end latency target). The held-out data contains **858 matchable A rows and 879 true pairs**, including duplicate occurrence structure; precision is measured on selected links, not on all possible true pairs.

**Decision:** this fixture supplies **no demonstrated precision or duplicate-B benefit** for the additional 80 correct auto links routed to review, even though the safety invariant is valuable. Do not remove the invariant or silently choose a global winner. Prioritize a narrower, provably one-to-one assignment policy and evaluate across more independent, collision-heavy labeled fixtures before promoting it. This holdout result is diagnostic, not sufficient evidence to tune a threshold on the same held-out data.

## Interpretation / next decision

A measured drop in automatic false positives with increased review cases is *not* an unequivocal quality victory. Report the exact held-out costs, especially true-positive auto links newly deferred. Threshold gates require an explicit product tradeoff and additional fixtures rather than retrofitting the heldout result into a tuned threshold.

Before considering any global maximum-weight assignment solver, obtain a separate adjudicated one-to-one ground truth with defined duplicate handling, and compare safe auto precision against review rate at fixed candidate recall. Never pretend that every valid cross-source link can be part of a one-to-one output when synthetic source duplicates deliberately exist.

## Explicit exclusions

No new AI or matcher scoring changes, no change to source immutability, mapping/survivorship policies, frontend review controls, or user uploads. No production tests, manual deployment, Railway access, PostgreSQL configuration, or changes to live services.
