# SW-006 holdout matcher report

Match scores are bounded evidence scores, not probabilities.

## Reproducibility

- Fixture: `organizations-dev-v1`
- Seed: `42`
- Candidate engine: `candidate-engine-v0.2.0`
- Feature pipeline: `feature-pipeline-v0.1.0`
- Matcher: `explainable-matcher-v0.2.0`

## Held-out evidence metrics

- Candidate recall: 100.000000%
- Candidate misses: 0
- Auto-match precision: 100.000000%
- Auto-match recall: 52.380952%
- Review rate: 42.105263%
- False auto-matches: 0
- Truth-uncovered A rows: 0
- Candidate-conditional feature-scoring coverage: 100.000000%
- Candidate-conditional review-threshold coverage: 100.000000%
- Candidate-conditional retained-link coverage: 100.000000%
- Top-1 true-candidate rate: 100.000000%
- Hard-negative auto-matches: 0

## Baseline comparison

- Baseline false auto-matches: 0
- Baseline auto-match precision: 100.000000%
- Baseline review rate: 36.842105%
- Baseline top-1 true-candidate rate: 100.000000%
