# Product

## Problem

Organizations often have two files that describe the same customers, vendors, or other entities, but inconsistent spelling, formatting, identifiers, and missing values prevent their rows from lining up. Manual reconciliation is slow, hard to audit, and easy to conflate with decisions about which data should be retained.

## 10-second explanation

Drop in two messy files. Samewise determines which records refer to the same entity, asks you about uncertain cases, and produces a trusted reconciled result.

## Core workflow

1. Accept two source datasets without modifying them.
2. Generate plausible cross-dataset candidates with recall as a gate.
3. Evaluate identity evidence and surface uncertainty for human review.
4. Record explainable, versioned identity decisions.
5. Resolve conflicting field values as a separate survivorship step.
6. Produce a reproducible reconciled result and evaluation evidence.

The local-development vertical slice implements CSV upload, profiling, optional
AI-assisted semantic mapping with explicit human confirmation, a first-class manual
fallback, truth-blind multi-pass candidate generation, a versioned explainable
multi-field scorer, ranked identity review, separate field resolution, and CSV export. The
model sees minimized schema statistics and never performs row identity decisions.
Candidate retention and scorer behavior have separate versioned synthetic evaluation
harnesses. Product match scores and AI mapping confidence are distinct systems and
neither is a calibrated probability.

The SW-007 review product groups retained alternatives by stable A-side row ID.
Reviewers can inspect and switch among B candidates without creating state, then
record SAME, DIFFERENT, or DEFER. A SAME/Different action advances only after the
server accepts it. SAME creates comparison-field conflicts but no field resolution;
DIFFERENT leaves other alternatives available; DEFER preserves unresolved identity.
The queue distinguishes system proposals from human confirmations and reports
reviewed, remaining, deferred, and filtered counts from the live run.

The SW-008 survivorship product starts only after an effective identity link. Raw
A/B comparison values remain visible and unresolved until a manual Use A, Use B,
or Keep Both action, or the explicit application of a previewed deterministic rule.
Policies support conservative non-null selection, explicitly mapped recency, and
per-field trusted sources. Rule-created values retain their policy version and never
masquerade as manual choices.

The reconciliation report remains available with unresolved identity or fields.
Trusted merged output is a separate gated CSV: all review items and relevant field
conflicts must be resolved. A-only and B-only rows retain source-only provenance;
KEEP BOTH retains dedicated source columns instead of inventing a canonical value.

## Evaluation foundation

Ground truth is created before matcher development so future changes can be compared against known identity relationships, including source-only entities, hard negatives, and duplicate source rows. The product-visible CSVs never contain canonical identifiers, corruption labels, or partner hints. Canonical entities, source-to-canonical mappings, schema mapping truth, and provenance are evaluation-only artifacts.

Synthetic fixtures make edge cases controllable and reproducible, but they do not establish production matching quality or prove that real customer data is represented. Future matcher evidence will need representative, appropriately governed evaluation data in addition to these synthetic benchmarks.

SW-006 uses a separately seeded tuning fixture to select conservative thresholds,
then freezes the matcher config before opening holdout truth. Evaluation reports
candidate misses, below-review-threshold true links, post-score retention misses,
auto-match precision,
review rate, top-1 ranking, hard-negative behavior, and empirical score bands with
explicit denominators. Downstream recovery is asserted not to exceed the candidate
recall ceiling.

## What Samewise is not

- It is not a fuzzy spreadsheet join with an AI label.
- It is not an autonomous AI system that authoritatively matches rows.
- It is not a tool that mutates source datasets.
- It is not a system that silently combines identity and field-selection decisions.
- It is not yet a database, durable upload service, queue, or production matching
  engine.

## Identity versus survivorship

Suppose file A contains `Acme Incorporated` with phone `555-0100`, while file B contains `ACME Inc.` with phone `555-0199`.

The identity question is: do these two records describe the same organization? Evidence may support “yes,” “no,” or human review.

Only after a “same entity” decision does survivorship ask: which phone value should appear in the reconciled result? The answer may depend on source authority, freshness, or a human decision. A strong identity match does not itself choose the winning phone number.

Deterministic synthetic rule tests can prove that “newer A selects A” under an
explicit policy. They cannot prove that the newer business value is true, and
Samewise does not report that as survivorship accuracy.
