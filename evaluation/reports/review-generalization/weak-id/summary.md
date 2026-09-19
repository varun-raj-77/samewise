# SW-006 holdout matcher report

Match scores are bounded evidence scores, not probabilities.

## Reproducibility

- Fixture: `organizations-weak-identifiers-1500-v1`
- Seed: `5051`
- Candidate engine: `candidate-engine-v0.4.0`
- Feature pipeline: `feature-pipeline-v0.2.0`
- Matcher: `explainable-matcher-v0.3.0`

## Held-out evidence metrics

- Candidate recall: 99.364214%
- Candidate misses: 7
- Auto-match precision: 100.000000%
- Auto-match recall: 19.346049%
- Review rate: 79.832714%
- False auto-matches: 0
- Truth-uncovered A rows: 6
- Candidate-conditional feature-scoring coverage: 100.000000%
- Candidate-conditional review-threshold coverage: 100.000000%
- Candidate-conditional retained-link coverage: 100.000000%
- Top-1 true-candidate rate: 99.532710%
- Hard-negative auto-matches: 0

## Baseline comparison

- Baseline false auto-matches: 0
- Baseline auto-match precision: n/a
- Baseline review rate: 99.628253%
- Baseline top-1 true-candidate rate: 97.289720%
