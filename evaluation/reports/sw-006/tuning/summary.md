# SW-006 tuning matcher report

Match scores are bounded evidence scores, not probabilities.

## Reproducibility

- Fixture: `organizations-matcher-tune-1200-v1`
- Seed: `6061`
- Candidate engine: `candidate-engine-v0.2.0`
- Feature pipeline: `feature-pipeline-v0.1.0`
- Matcher: `explainable-matcher-v0.2.0`

## Tuning evidence metrics

- Candidate recall: 98.297389%
- Candidate misses: 15
- Auto-match precision: 100.000000%
- Auto-match recall: 26.787741%
- Review rate: 71.478463%
- False auto-matches: 0
- Truth-uncovered A rows: 15
- Candidate-conditional feature-scoring coverage: 100.000000%
- Candidate-conditional review-threshold coverage: 99.884527%
- Candidate-conditional retained-link coverage: 99.884527%
- Top-1 true-candidate rate: 99.053254%
- Hard-negative auto-matches: 0

## Baseline comparison

- Baseline false auto-matches: 0
- Baseline auto-match precision: 100.000000%
- Baseline review rate: 98.952270%
- Baseline top-1 true-candidate rate: 96.568047%
