# Reports

SW-002 fixture summaries report dataset arithmetic, corruption counts, and
hard-negative patterns only. SW-005 candidate reports are produced by an executable
evaluation harness after truth-blind generation. They may report candidate recall
and reduction, but never final matching precision, recall, or accuracy.

SW-006 matcher reports are a separate artifact class. They may report scoring and
decision metrics only after visible candidate generation/scoring and a hidden-truth
join. Tuning and holdout fixture names, seeds, configs, and phases must be explicit.
