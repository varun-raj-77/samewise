# SW-006 explainable matcher evaluation

SW-006 uses two separately seeded 1,200-entity weak-identifier fixtures. The
tuning fixture (`seed=6061`, weak-policy seed `9061`) was used to inspect feature
behavior and choose thresholds. The matcher config was then frozen at
`evaluation/configs/matcher-v0.2.0.json`. The holdout fixture (`seed=7071`,
weak-policy seed `10071`) was evaluated after the freeze and was not used to alter
weights or thresholds.

## Frozen decision rules

- Auto-match threshold: `0.50`
- Review threshold: `0.25`
- Minimum top-candidate margin: `0.04`
- Minimum agreeing fields for auto-match: `2`
- Strong phone/email/domain contradiction: blocks auto-match
- Preferred-B collision: routes to review
- Alternatives: at most 3, score at least `0.25` and within `0.30` of top

## Holdout facts

- A rows / B rows: 1,044 / 1,044
- Theoretical pairs: 1,089,936
- Candidate pairs: 4,132
- True links: 879
- Candidate recall: 866/879 = 98.5210466%
- Candidate misses: 13
- Auto-matches: 253
- True auto-matches: 253
- False auto-matches: 0
- Pair-level auto-match precision: 100%
- Pair-level auto-match recall: 28.7827076%
- Review rate: 598/858 matchable A rows = 69.6969697%
- Candidate-conditional feature-scoring coverage: 866/866 = 100%
- Candidate-conditional review-threshold coverage: 866/866 = 100%
- Candidate-conditional retained-link coverage: 864/866 = 99.7690531%
- Post-score retention misses: 2
- Truth-uncovered A rows: 14
- Top-1 true-candidate rate: 839/846 eligible A rows = 99.1725768%
- Hard-negative candidate pairs evaluated: 6
- Hard-negative auto-matches: 0

The old baseline on the identical candidates produced no auto-matches, routed
851/858 matchable A rows to review (99.1841492%), and ranked a true candidate first
for 824/846 eligible rows (97.3995272%). Its auto-match precision is undefined
because its auto-match denominator is zero.

The holdout candidate-recall ceiling is 866/879. All 866 generated true pairs
received features and scores, and all 866 met the review threshold. The matcher
retained 864 true pairs in its visible alternatives. Thirteen misses occurred
before scoring; two generated, above-threshold true pairs ranked fourth and were
excluded by the explicit top-three alternative limit. End-to-end recovery
(864/879) remains below the candidate ceiling, as required.

`tuning/report.json` and `holdout/report.json` contain the exact machine-readable
metrics, decomposition, score bands, hard-negative results, ranking diagnostics,
candidate config, and frozen matcher config. Scores are not probabilities.
`metrics-closeout.md` reconciles every pair-level and A-row-level denominator and
records the two post-score retention losses.

## Development-fixture inspection and product walkthrough

`dev/report.json` evaluates the frozen matcher on `organizations-dev-v1` after
scoring and records all nine generated hard-negative candidate pairs. None was
auto-matched; their match scores range from `0.085181` to `0.214492`.

`walkthrough/sw006-closeout.json` is the factual browser walkthrough report.
It records the visible result bands, the ambiguous top/alternate pair inspected,
the separate human SAME decision, post-identity comparison conflicts, zero
automatic survivorship resolutions, and immutable source hashes. The adjacent
PNG files are the retained results, feature-evidence, and conflict screens.
