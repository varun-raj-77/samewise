# SW-013 adversarial competitor validation

This package tests where Samewise adds value and where a simpler or more mature
tool is the better choice. It is evaluation evidence, not a feature milestone.
Product code, matcher weights, thresholds, infrastructure, and UI behavior are
unchanged.

## Evidence modes

- **EXECUTED**: reproduced locally. Only Samewise has this status in SW-013.
- **DOCUMENTED CAPABILITY**: supported by current official documentation, but not
  executed here.
- **NOT VERIFIED**: current evidence was insufficient. This never means absent.

Competitor claim classes are `CONFIRMED`, `VENDOR CLAIM`, `INFERRED`, and
`NOT VERIFIED`. Performance and accuracy statements published by Data Ladder are
kept as vendor claims and are not treated as measurements.

## Scenario suite

| ID | Scenario | Primary adversary | Thesis color |
| --- | --- | --- | --- |
| S01 | Clean exact join | Power Query / SQL | RED |
| S02 | Normalized multi-field join | Power Query | RED |
| S03 | Simple fuzzy text | Power Query | RED/YELLOW |
| S04 | Contradictory multi-field evidence | Power Query | GREEN |
| S05 | Near-tie ambiguity | DataMatch | INCONCLUSIVE |
| S06 | Colliding matches | dedupe / Power Query | GREEN for visibility; no assignment claim |
| S07 | Identity versus survivorship | DataMatch | YELLOW |
| S08 | Matcher regression | Splink / DataMatch | YELLOW/GREEN |
| S09 | Audit and reproducibility | DataMatch / Power Query | YELLOW/GREEN |
| S10 | Reviewer throughput | DataMatch | INCONCLUSIVE |

Every scenario has `dataset_a.csv`, `dataset_b.csv`, `scenario.json`, and a
separate `truth/identity_truth.json`. Visible product inputs contain no truth,
canonical entity, or expected-match column.

## Reproduce

From the repository root:

```text
services/matcher/.venv/Scripts/python.exe evaluation/competitors/sw-013/validate.py --write
```

On a POSIX environment use the project interpreter or:

```text
uv run --project services/matcher python evaluation/competitors/sw-013/validate.py --write
```

The validator runs the production candidate engine and matcher twice, rejects
truth-like input columns, checks scenario invariants, and writes
`scenario-results.json` plus the Power Query reproduction CSVs. The checked-in
test imports the same validator without rewriting artifacts.

## Artifacts

- `scenario-results.json`: executed Samewise counts, hashes, and scenario-level
  documentary competitor conclusions.
- `competitor-matrix.json`: DataMatch feature matrix, dedupe/Splink engineering
  matrix, evidence classes, vendor claims, and secondary context.
- `research-sources.md`: claim-to-official-source audit.
- `power-query/`: documentary reproduction package and blank result template.
- `summary.md`: product-thesis, user-fit, privacy, positioning, and verdicts.

Power Query, DataMatch Enterprise, dedupe, and Splink were not installed or run.
No comparative failure or performance result is claimed for them.
