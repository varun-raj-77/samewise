# Evaluation

Versioned fixture manifests, candidate configs, deterministic snapshots, and
reproducible candidate-generation reports live here. SW-002 summaries remain
fixture facts only. SW-005 reports are limited to candidate retention, pair
reduction, blocker diagnostics, runtime, and measured Python allocation peak. They
make no final scoring precision, recall, accuracy, or production claim.

`reports/sw-005f` contains the adversarial weak-identifier ablation, strong/weak
stratification, suppression audit, hard-negative coverage, v0.1/v0.2 comparison,
and preserved miss inventory.

`reports/sw-006` contains a fixed tuning run and one post-freeze held-out matcher
evaluation. It reports candidate recall separately from auto-match precision/recall,
candidate-conditional feature-scoring coverage, review-threshold coverage,
retained-link coverage, review rate, false auto-matches, truth-uncovered A rows,
top-1 ranking, hard-negative behavior, score bands, and legacy baseline comparison.
Match scores are not probabilities.
