# SW-051 — Keep candidate misses inspectable across confirmed semantic mappings

## Problem

The candidate generator supports confirmed semantic identity families, including `persistent_identifier`, `name_or_title`, `contact_person`, and `unknown`. The evaluation-only missed-truth diagnostic used an older family-to-normalizer table, so `evaluate_candidates` could raise `KeyError` instead of reporting candidate recall and visible evidence whenever a true pair was missed under one of those newer mappings.

Without a miss report, Samewise cannot reliably measure what candidate generation throws away or evaluate whether an alternative blocking strategy is safer.

## Changes

- Cover every confirmed semantic mapping family with the appropriate visible-data normalization snapshot, while preserving legacy inferred mapping families.
- Explicitly reject truth pairs that reference source row IDs absent from the fixture, rather than failing later with an implicit lookup error.
- Add independent parameterized regression cases for 14 semantic families, plus an invalid-truth-ID case. The tests use deliberately different A/B values so the known true pair is missed; the hidden label is given to the evaluator **after** truth-blind generation.

## Acceptance

- Missed true pairs generate an inspectable `visibleMappedValues` diagnostic under every confirmed semantic family instead of a `KeyError`.
- The evaluator reports candidate recall **0/1** for the constructed one-pair miss and does **not** claim final matching recall or auto-match precision.
- An invalid truth pair fails explicitly with a descriptive validation error.
- No blocker keys, candidate IDs, scoring, one-to-one policy, threshold, fixture truth, or source record are changed.
- The repository verification, Python lint/tests, CI matcher benchmarks, and web browser acceptance must pass before merge.

## Next hypothesis to test

A source pair can refer to the same organization despite a complete name change, while matching on a stable physical address and geography. Current default blocking uses address *with name* and does not guarantee this pair enters the candidate set. The next experiment should add a **separate truth-labeled fixture**, measure candidate recall and extra hard negatives under a candidate-only address/location pass, benchmark bucket caps on 1K/10K, and compare against unchanged `candidate-engine-v0.4.0`. Do not enable a new blocker or loosen auto-match decisions without those measurements and a versioned matcher change.

## Scope boundary

This is an evaluation reliability fix, not a candidate-recall improvement. All reported examples are synthetic. It adds no production claims, no hidden-truth dependency in the product matcher, and no external infrastructure changes.
