# Samewise matcher

This uv-managed Python package is the process boundary for profiling, SW-005
multi-pass candidate generation, and the SW-006 explainable multi-field matcher.
It also retains the SW-003 baseline for comparison and contains the health command,
hidden-truth evaluators, and deterministic fixture tooling.

```text
uv sync --project services/matcher --locked
uv run --project services/matcher samewise-matcher health
```

`samewise-matcher process` accepts one versioned JSON profile or match request on
stdin and returns JSON on stdout. Product match requests use the candidate engine,
then apply `feature-pipeline-v0.1.0` and `explainable-matcher-v0.2.0`.
The explicit `all_pairs` mode is retained for small-fixture oracle tests only.
Comparison/survivorship mappings do not affect identity candidates or scores.

Generate and inspect a versioned organization fixture:

```text
uv run --project services/matcher samewise-matcher fixtures generate --seed 42 --entities 24 --fixture organizations-dev-v1
uv run --project services/matcher samewise-matcher fixtures summarize --fixture organizations-dev-v1
```

Use `--output-root` to write the same repository-shaped artifact tree beneath a temporary directory. The generator does not use wall-clock time; its files are stable for the same generator version, validated configuration, and seed.

Candidate CLI phases are independently invocable:

```text
samewise-matcher candidates generate --a A.csv --b B.csv --mappings mappings.json --config candidate-config.json --output candidates.json
samewise-matcher candidates evaluate --a A.csv --b B.csv --mappings mappings.json --candidates candidates.json --truth identity_truth.json --provenance corruption_provenance.jsonl --output-dir report
samewise-matcher candidates benchmark --root ROOT --fixture NAME --mappings mappings.json --config candidate-config.json --output-dir report
```

`generate` has no hidden-truth argument. `evaluate` is the only phase that loads
identity truth or optional corruption provenance. Benchmark output includes
`candidates.json`, `report.json`, `summary.md`, and `misses.json`.

SW-005F adds `fixtures generate-weak-config` and `candidates falsify`. Falsification
runs full, exact-only, no-exact, and leave-one-family-out variants, then performs
hidden-truth strong/weak stratification, suppression analysis, and hard-negative
coverage. Earlier candidate-engine versions remain runnable for historical
reproduction; product matching defaults to `candidate-engine-v0.3.0`.

Matcher evaluation has a guarded two-phase workflow:

```text
samewise-matcher matcher tune --root ROOT --fixture TUNE --mappings mappings.json --candidate-config candidate.json --matcher-config tuning-template.json --output-dir tuning-report
samewise-matcher matcher evaluate --root ROOT --fixture HOLDOUT --mappings mappings.json --candidate-config candidate.json --matcher-config frozen-matcher.json --output-dir holdout-report
```

`tune` searches deterministic auto/review/margin thresholds against tuning truth and
writes a frozen config. `evaluate` rejects an unfrozen config or a config tuned on
the same fixture. Both phases generate visible candidates and scores before opening
hidden truth. Reports include exact denominators, candidate misses,
below-review-threshold true links, post-score alternative losses,
decomposition, empirical score bands, hard negatives, and baseline comparison.

Feature computation uses Python's standard-library `SequenceMatcher` behind
Samewise-owned functions plus explicit token, identifier, location, and address
features. RapidFuzz was evaluated as a dependency choice but not added: this
milestone's measured improvement comes from feature semantics, weights, conflicts,
and decision rules rather than substituting one fuzzy primitive.
