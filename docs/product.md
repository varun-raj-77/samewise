# Product

## Problem

Organizations often have two files that describe the same customers, vendors, or other entities, but inconsistent spelling, formatting, identifiers, and missing values prevent their rows from lining up. Manual reconciliation is slow, hard to audit, and easy to conflate with decisions about which data should be retained.

## 10-second explanation

Drop in two messy files. Samewise determines which records refer to the same entity, asks you about uncertain cases, and produces a trusted reconciled result.

## Core workflow

The primary product is organized around five user jobs:

1. Upload files.
2. Set up matching.
3. Review matches.
4. Choose merge rules.
5. Export.

The sources remain immutable and identity remains separate from choosing surviving
values. A mapped field may participate in both phases: `useForMatching` controls
identity evidence and `includeInMerge` controls post-identity value comparison.
Profiles, complete result inspection, and Matching quality are secondary surfaces,
not peer workflow steps.

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

The merge-values product starts only after an effective identity link. Raw
A/B comparison values remain visible and unresolved until a manual Use A, Use B,
or Keep Both action, or the explicit application of a previewed deterministic rule.
Policies support conservative non-null selection, explicitly mapped recency, and
per-field trusted sources. Rule-created values retain their policy version and never
masquerade as manual choices.

The reconciliation report remains available with unresolved identity or fields.
Ready-to-export merged output is a separate gated CSV: all review items and relevant field
conflicts must be resolved. A-only and B-only rows retain source-only provenance;
KEEP BOTH retains dedicated source columns instead of inventing a canonical value.

SW-010 makes the result portable without pretending unresolved work is complete.
The Export screen separates the reconciliation report, gated trusted merged output,
and a machine-readable run provenance manifest. The manifest binds exact CSV hashes
to immutable source fingerprints and the mapping, candidate, matcher, identity, and
survivorship state used to produce them. Re-export from unchanged authoritative
state is deterministic. Ordinary product manifests state that no Evaluation
snapshot is attached; they never import hidden synthetic truth.

SW-012 keeps that authoritative evidence intact while removing the giant eager
browser dependency. Results, Review, and conflicts load deterministic 50-item
pages; selecting a candidate retrieves its complete retained source records,
features, blocker provenance, scores, rank, collision context, and decision state.
On the real 10K path, the largest initial page was 88,351 bytes rather than the
56,892,493-byte matcher result. This improves constrained demo delivery but does
not make process-local state durable or reduce the retained evidence object.

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

SW-009 makes this evidence inspectable in a dedicated product area. Versioned,
content-addressed snapshots distinguish synthetic ground truth from nonrepresentative
human review labels. Compatible matcher snapshots show percentage-point deltas;
incompatible fixtures or evaluator semantics show no delta. Metrics lead to paged
candidate-miss, ranking, retention, false-auto-match, and hard-negative examples.

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
