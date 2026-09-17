# Evaluation

SW-009 adds versioned evaluation product artifacts under `reports/sw-009`, an
explicit holdout gate configuration under `configs`, and `samewise-matcher
evaluation run|compare|inspect-errors`. Snapshot content identity excludes wall-clock
time and includes evaluation semantics and provenance. Error payloads are separate
from the catalog so the API can page them without enlarging normal product state.

See `docs/sw-009-evaluation.md` for metric denominators, compatibility rules, source
types, frozen reproduction facts, and the human-label sampling caveat.

Versioned fixture manifests, candidate configs, deterministic snapshots, and
reproducible candidate-generation reports live here. SW-002 summaries remain
fixture facts only. SW-005 reports are limited to candidate retention, pair
reduction, blocker diagnostics, runtime, and measured Python allocation peak. They
make no final scoring precision, recall, accuracy, or production claim.

`competitors/sw-013` contains the adversarial product-thesis validation: ten small
truth-isolated scenarios, executed Samewise results, official-source competitor
matrices, and a documentary Power Query reproduction package. External products
were not executed; their cells are explicitly documented capability or not
verified, never fabricated comparative results.

`reports/sw-005f` contains the adversarial weak-identifier ablation, strong/weak
stratification, suppression audit, hard-negative coverage, v0.1/v0.2 comparison,
and preserved miss inventory.

`reports/sw-006` contains a fixed tuning run and one post-freeze held-out matcher
evaluation. It reports candidate recall separately from auto-match precision/recall,
candidate-conditional feature-scoring coverage, review-threshold coverage,
retained-link coverage, review rate, false auto-matches, truth-uncovered A rows,
top-1 ranking, hard-negative behavior, score bands, and legacy baseline comparison.
Match scores are not probabilities.
