# SW-009 evaluation product

## Architecture and truth boundary

```text
frozen visible fixture
→ candidate engine
→ requested matcher version
→ hidden truth opened after matching
→ matcher-evaluation-v0.3.0 snapshot
→ compatibility check + gates + error artifacts
→ dedicated API + React evaluation screen
```

Product matching receives visible rows, confirmed mappings, and versioned matcher
configuration only. It does not receive canonical entity IDs, schema truth,
corruption provenance, hard-negative labels, or review labels. Evaluation artifacts
are not part of `RunView`, and the ordinary product can start when evaluation
artifacts are unavailable.

## Source types

`SYNTHETIC_GROUND_TRUTH` is fully labeled, deterministic fixture evidence. It
supports benchmark recall, precision, and stage decomposition, but cannot prove
real-data quality.

`HUMAN_REVIEW_LABELS` captures SAME/DIFFERENT decisions from product use. The current
review queue is ambiguity-enriched rather than random. The UI calls these results
“Human Review Evidence” and “reviewed labeled subset,” displays the sampling caveat
directly, and never turns them into a full-dataset accuracy claim.

## Snapshot and artifact versions

- Snapshot: `evaluation-snapshot-v1.0.0`
- Evaluator: `matcher-evaluation-v0.3.0`
- Comparison: `evaluation-comparison-v1.0.0`
- Error taxonomy: `evaluation-error-taxonomy-v1.0.0`
- Gates: `matcher-quality-gates-v1.0.0`

The content hash covers source identity, dataset fingerprints, configurations,
metrics, score bands, what-if analysis, artifact provenance, and gate results.
Wall-clock time is absent, so identical inputs produce identical snapshot identities.
A changed matcher, configuration, fixture, evaluator, or gate result creates a new
snapshot rather than silently editing an old one.

Checked-in evidence lives in `evaluation/reports/sw-009`. Ephemeral local runs should
be written under ignored `.samewise-data` paths until intentionally reviewed.

## Exact metric definitions

| Metric | Level | Numerator | Denominator |
| --- | --- | --- | --- |
| Candidate reduction | search space | theoretical pairs not emitted | all A×B theoretical pairs |
| Candidate recall | pair | true links emitted as candidates | all true cross-source links |
| Feature-scoring coverage | pair, candidate-conditional | true candidate links feature-scored | true links emitted as candidates |
| Retained-link coverage | pair, candidate-conditional | true links available to decision coverage | true links emitted as candidates |
| Auto-match precision | pair | true automatically linked pairs | all automatically linked pairs |
| Auto-match recall | pair | true automatically linked pairs | all true cross-source links |
| Review rate | A-row | review-routed matchable A rows | A rows with one or more cross-source truth links |
| End-to-end recovery | pair | true links retained for automatic or human decision | all true cross-source links |
| Top-1 true-candidate rate | A-row | eligible A rows with a true top pair | candidate-reached matchable A rows |

Precision is undefined when no pairs are auto-matched; it is never rendered as 0%.
Pair-level duplicate-expanded links must not be subtracted from row-level review
counts. End-to-end recovery is invariantly bounded by candidate recall.

## Frozen holdout reproduction

On `organizations-matcher-holdout-1200-v1`, regeneration produced:

- candidate recall: 866 / 879 = 98.5210466%;
- end-to-end recovery: 864 / 879 = 98.2935154%;
- auto-match precision: 253 / 253 = 100%;
- pair-level auto-match recall: 253 / 879 = 28.7827076%;
- review rate: 598 / 858 matchable A rows = 69.6969697%;
- top-1 true candidate: 839 / 846 = 99.1725768%;
- candidate misses: 13;
- post-score retention losses: 2;
- false auto-matches: 0;
- hard-negative auto-matches: 0.

These reproduce accepted SW-006 evidence. They are generated facts, not values
embedded in evaluator code.

| Metric | baseline-matcher-v0.1.0 | explainable-matcher-v0.2.0 | Delta |
| --- | ---: | ---: | ---: |
| Candidate recall | 98.5210466% | 98.5210466% | 0.0000000 pp |
| Auto-match precision | undefined | 100% | undefined |
| Auto-match recall | 0% | 28.7827076% | +28.7827076 pp |
| Review rate | 99.1841492% | 69.6969697% | -29.4871795 pp |
| Top-1 true candidate | 97.3995272% | 99.1725768% | +1.7730496 pp |
| False auto-matches | 0 | 0 | 0 |

No automated winner label is attached to these tradeoffs.

## Compatibility and gates

A direct comparison requires the same source type and label/fixture identity,
dataset fingerprints, candidate-engine version and configuration, and evaluator
semantics. An incompatible comparison emits no deltas.

The holdout gate requires candidate recall ≥ 0.985, auto-match precision ≥ 0.995,
zero false auto-matches, zero hard-negative auto-matches, and the candidate ceiling
invariant. Exact retained facts remain reproducibility checks; gates are deliberately
modest quality policy rather than dozens of overfit exact values.

## Errors, score bands, and threshold analysis

The taxonomy contains `candidate_no_shared_key`, `ranking_wrong_top1`,
`retention_top_n`, `retention_threshold`, `auto_match_false_positive`,
`unmatched_candidate_miss`, `unmatched_decision_policy`, and
`hard_negative_case`. Error artifacts include visible A/B records, real score and
evidence, blocker provenance where available, pipeline stage, and a strongly marked
evaluation-only truth label. The API caps pages at 100; the UI requests 20.

Each score band reports candidate, true, and false counts plus its empirical match
rate on the frozen fixture. Scores are not rescaled and no calibration claim is made.

Threshold what-if evaluates 0.45, 0.50, 0.55, 0.60, and 0.65 while holding margin,
collision, contradiction, agreement, and retention rules fixed. It reports counts,
precision, recall, review rate, and false auto-matches. It is retrospective analysis
only and cannot update product configuration.

## Human evidence and replay

New identity decisions retain candidate pair, evidence shown, match score, matcher
version, candidate-engine version, system proposal, decision, and time. The API
reports SAME/Different counts, agreement only where a binary auto-match proposal
existed, rejected auto proposals, top-versus-alternate counts, and provenance.

Historical-label re-scoring is not exposed as polished UI in SW-009. Original labels
and provenance are sufficient for a later replay adapter, which must add separate
replay fields and never overwrite original evidence. No labels train or alter the
same-run matcher.

## Commands

```text
samewise-matcher evaluation run --root . --fixture organizations-matcher-holdout-1200-v1 --mappings evaluation/configs/organizations-confirmed-mappings-v1.json --candidate-config evaluation/configs/candidate-engine-v0.2.0.json --matcher-config evaluation/configs/matcher-v0.2.0.json --gates evaluation/configs/matcher-quality-gates-v1.0.0.json --output-dir evaluation/reports/sw-009

samewise-matcher evaluation compare --snapshot-a <snapshot.json> --snapshot-b <snapshot.json> --output-dir <comparison-dir>

samewise-matcher evaluation inspect-errors --errors <errors.json> --type candidate_misses
```
