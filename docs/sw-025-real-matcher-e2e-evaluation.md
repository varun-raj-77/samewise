# SW-025 — Real matcher end-to-end evaluation on newly seeded synthetic inputs

## Objective

Measure the actual production Python data-matching pipeline **from blocker candidates through explainable scoring/alternative retention and the version-pinned conservative one-to-one assignment**. This addresses the limitation of SW-024's hand-authored candidate graphs and provides stage-separated evidence before another algorithm is considered.

## New evaluation cohorts, held separate from earlier tuning/holdout fixtures

All three fixture configs are committed under `evaluation/benchmark-configs/sw-025/` and have previously unused deterministic seeds. Each run generates new CSVs and canonical-entity ground truth into an isolated temporary directory using the project's existing versioned fixture generator; files are destroyed on completion. No real customer data, model calls or dataset uploads enter this workflow.

- `moderate-distinct`: 180 canonical entities, moderate corruption, 8 duplicate rows on each side, seed 825031.
- `high-corruption`: 180 entities, elevated corruption rates, 18 duplicate rows on each side, seed 825032.
- `duplicate-dense`: 180 entities, moderate corruption, 44 duplicate rows on each side, seed 825033.

These are **new deterministic synthetic generator samples**, not independently human-adjudicated production datasets and not proof of domain generalization. They share the generator's organization naming grammar with earlier fixtures. Thus their error patterns have common-model limits; further human-curated, diverse real-world cases remain important.

The existing `organizations-confirmed-mappings-v3-semantic.json` mapping stays frozen. No matcher configuration, thresholds, rule weights, model prompts or assignment algorithms are modified.

## Two separate Python invocations and measured layers

The benchmark uses the actual `samewise_matcher.cli candidates generate` path and the production `createMatcherRunner().match()` Python subprocess on the **same newly generated visible A/B files** and confirmed identity mappings. Hidden ground truth is read only for metric computation, not passed to either matcher invocation.

1. **Blocking/candidate generation**: all generated candidate pair IDs. Measure true-pair candidate recall (including duplicate occurrences), candidate reduction `1 - generated/(A×B)`, and missed canonical true links. This is *pre-scoring*, unlike SW-022's retained-pair reduction.
2. **Scoring/classification/alternative retention**: actual structured `MatcherResultSchema` output. Measure true pairs still present, total retained pairs, and the number of generated truth pairs absent after scoring/retention. The latter **cannot** uniquely distinguish threshold failures from top-N alternative pruning and is labeled as a combined loss.
3. **Assignment and human review demand**: the current SW-021 `automaticIdentityCandidateIds` product selector. Measure one-to-one B uniqueness, true/false auto links, auto precision (null for zero selected), truth-pair and matchable-A recall, review-routed A rows, A rows without retained candidates and the two review-rate denominators. No human judgments are simulated.
4. **Runtime and provenance**: report fixture generation, upstream blocker subprocess, and matcher subprocess wall time separately. Each is a single CI measurement including process startup, **not production latency or memory benchmarks**. Include SHA-256 for both CSV inputs, generated truth, confirmed mappings, and all frozen fixture configurations.

The benchmark checks all generated and retained pair IDs against ground truth, rejects duplicated pair IDs, rejects unknown IDs, and confirms that every retained candidate is present in the same candidate-generator pass with the same engine version. Failure is explicit, never silently reconciled.

## Reproduce

```sh
pnpm install --frozen-lockfile
uv sync --project services/matcher --locked
pnpm benchmark:sw025
```

Output is `evaluation/reports/sw-025/latest-ci.json`, printed in CI as well. This artifact is generated, not filled with hypothetical quality numbers. CI also executes `pnpm verify`, historic SW-022, SW-024 adversarial graphs and the production web build.

## Acceptance and limitations

- All three fixture cohorts pass through the actual Python candidate engine and matcher; no hand-fabricated candidate pairs appear in the SW-025 metrics.
- Truth-pair blocker recall, retained truth-pair recall, and automatic precision use different correct denominators. A one-to-one product cannot output all legitimate pair links where duplicate occurrences create many-to-many truth.
- False auto cases and blocker misses are visibly countable, including examples of **row IDs only**, not raw uploaded records.
- If the real matcher is overly conservative, report it; do not tune thresholds against these evaluation fixtures.
- There are no production matcher changes, new AI calls, user source mutations, changed field-survivorship behavior, database updates, manual deployment, or Railway access.
- Performance and correctness observed in these three synthetic cohorts must not be advertised as a production SLA or statistically representative precision/recall.

## Decision after measurement

Do not ship a new automatic assignment algorithm just to improve review-rate optics. Use these results alongside independent manual-label adversarial cases to determine whether candidate misses, post-score pruning, ranking, or one-to-one conservative assignment actually accounts for missed true links. Preserve human decisions and versioned identity semantics when proposing future changes.
