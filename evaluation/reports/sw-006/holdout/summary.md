# SW-006 holdout matcher report

Match scores are bounded evidence scores, not probabilities.

## Reproducibility

- Fixture: `organizations-matcher-holdout-1200-v1`
- Seed: `7071`
- Candidate engine: `candidate-engine-v0.2.0`
- Feature pipeline: `feature-pipeline-v0.1.0`
- Matcher: `explainable-matcher-v0.2.0`

## Held-out evidence metrics

- Candidate recall: 98.521047%
- Candidate misses: 13
- Auto-match precision: 100.000000%
- Auto-match recall: 28.782708%
- Review rate: 69.696970%
- False auto-matches: 0
- Truth-uncovered A rows: 14
- Candidate-conditional feature-scoring coverage: 100.000000%
- Candidate-conditional review-threshold coverage: 100.000000%
- Candidate-conditional retained-link coverage: 99.769053%
- Top-1 true-candidate rate: 99.172577%
- Hard-negative auto-matches: 0

## Baseline comparison

- Baseline false auto-matches: 0
- Baseline auto-match precision: n/a
- Baseline review rate: 99.184149%
- Baseline top-1 true-candidate rate: 97.399527%
