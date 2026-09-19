# Review generalization closeout

Date: 2026-09-19  
Decision: **REVIEW GENERALIZATION PASS — HUMAN REVIEW IS TARGETED AND DATASET-ADAPTIVE**

## 1. Executive summary

Samewise now constructs a versioned semantic evidence plan from confirmed
mappings, selects comparators and candidate routes by bounded semantic family,
surfaces deterministic information-value context, and turns repetitive review
work into safe human-confirmed groups. AI remains metadata-only and advisory;
identity decisions remain deterministic system proposals or explicit human
actions.

On the deterministic public-style 8K × 8K regression, automatic matches remain
6,178 with 100% measured precision and 100% candidate recall. Review drops from
1,312 to 822 because 490 source-only/no-truth candidates no longer enter the
queue. The remaining 822 true-top cases form three review groups, all eligible for
conservative human batch SAME, leaving zero individual clicks after group action.

The frozen holdout keeps 98.521047% candidate recall, improves end-to-end recovery
from 98.293515% to 98.521047%, and retains zero false automatic and hard-negative
automatic matches. The exact semantic comparators are more conservative than the
legacy scorer, so automatic count falls and review count rises on that fixture;
this is recorded rather than hidden. Thresholds did not change.

## 2. Existing architecture audited

The audit covered confirmed mappings v2, strict semantic-mapping output, profile
metadata, indexed blocking, inferred field kinds, features and contributions,
contradictions, collisions, two-field automatic-match minimums, thresholds,
alternatives, bounded review APIs/UI, decision provenance, undo/defer/restore,
SW-005/SW-005F, SW-006, SW-009, SW-012, and fixture generators. The pre-change
findings and affected-version inventory were recorded before production behavior
changed in `docs/review-generalization-plan.md`.

The locked Upload → Match setup → Review matches → Merge values → Export workflow,
source immutability, identity/survivorship separation, and explicit trusted-export
gates are preserved.

## 3. Phase-1 diagnosis and exact queue composition

Ground truth was held outside candidate generation and scoring, then joined only
for evaluation. The committed config regenerates the workload without committing
large CSVs.

| Metric | Before |
| --- | ---: |
| Theoretical pairs | 64,000,000 |
| Candidate pairs | 12,366 |
| Candidate reduction | 99.9806781% |
| Candidate recall | 100% |
| Automatic matches | 6,178 |
| Automatic precision | 100% |
| False automatic / hard-negative automatic | 0 / 0 |
| Review cases | 1,312 |
| True pair is top candidate | 822 |
| False top / no true candidate available | 490 / 490 |
| Truth only in alternatives | 0 |
| Collisions / near ties | 0 / 0 |
| Review yield | 62.652439% |
| Product no-match in B / product no-match in A | 510 / 510 |
| Internal matcher A-only / B-not-auto-linked | 510 / 1,822 |

Review yield means true underlying matches appearing in review divided by total
review cases. It is not precision.

The dominant true-review pattern was a partial entity-name agreement, exact
contact-person and address support, missing email and postal values, a phone
conflict, and no strong contradiction or collision. The 490 false/no-value cases
were source-only records joined through a source-local value plus repeated
supporting context while the stronger identity fields conflicted. Human review
could not discover a true B record because none existed.

Artifacts: `evaluation/benchmarks/review-workload/analysis.json` and `summary.md`.

## 4. Semantic evidence model

Confirmed mappings v3 adds one bounded semantic family: persistent identifier,
source-local identifier, name/title, contact person, email, phone, domain,
address, geography, categorical, numeric, date/timestamp, free text, or unknown.
The added domain family preserves Samewise's existing normalized-host comparator
for website fields. The semantic mapping model may suggest these values from
bounded metadata, but a user must confirm the setup. Whole datasets are not sent
to the model.

Legacy v1/v2 mappings remain interpretable by deterministic inference. An
explicitly confirmed `unknown` family does not fall back to name-based guessing.

### Identifier, name, and comparator behavior

- Persistent identifiers: normalized exact only. Shared prefixes or almost-equal
  UPC/UUID-like values are conflicts, never partial matches. A conflict is a
  strong contradiction.
- Source-local identifiers: excluded from cross-source identity routing by
  default. Explicit overrides remain auditable.
- Entity name/title: normalized token and character similarity.
- Contact person: name-like comparison, but lower/supporting semantics and a
  separate family from entity identity.
- Email, phone, and domain: deterministic normalization with exact semantic
  comparison; no invented phone-country inference.
- Address: deterministic address normalization and existing bounded similarity.
- Geography/categorical: exact or conservative supporting evidence.
- Numeric: exact by default. Date/timestamp: deterministic exact comparison and
  remains available as helper metadata for deterministic survivorship rules.
- Free text/unknown: conservative normalized exact supporting evidence.

Multiple strong agreements plus a mutable phone conflict preserve the conflict in
the trace but can remain reviewable/groupable. One name plus a conflicting phone
cannot auto-match.

## 5. Profiles, distinctiveness, and evidence planning

Profiles now retain normalized distinct count/rate, most-common value count/rate,
average value length, and bounded pattern shape in addition to existing row,
null, primitive-type, and distinct metadata. Evidence planning calculates bounded
per-mapping non-null/distinct/common counts and cross-source exact-overlap counts,
selects a comparator, and persists the candidate strategy/config. Full frequency
tables are transient and are not written to manifests.

Pair evidence records value frequencies and the deterministic information class:
distinctive, repeated, common, not applicable, or unknown. These classes drive
setup warnings, explanations, grouping, and batch safety.

Frequency-aware score scaling was **not accepted**. An inverse-square-root
frequency multiplier was measured and caused a material frozen-holdout recovery
loss. Production therefore records `classification_only_no_score_adjustment` in
evidence-plan v1. A future scoring adjustment requires a new versioned decision
and all quality gates.

## 6. Dataset-adaptive candidate planning and abstention

Candidate-engine v0.4 derives routes from confirmed matching fields and semantic
families. Persistent IDs and normalized email/phone/domain values receive exact
routes; names use bounded name indexes; names can combine with address/geography;
contact people and other supporting fields use conservative exact/context routes;
source-local IDs are excluded by default. Bucket suppression and blocker/key-hash
provenance remain bounded and deterministic.

Zero matching fields block execution. Weak-only setup produces the required
warning that different entities may share the values and Samewise may leave more
records unmatched or in review. The low-information fixture creates no automatic
matches. Duplicate confirmed persistent values trigger: “Possible duplicate
entities exist within this source. Competing matches will be routed to review.”
No clustering or global assignment was added.

## 7. Before/after public 8K workload

| Metric | Before | After |
| --- | ---: | ---: |
| Theoretical pairs | 64,000,000 | 64,000,000 |
| Candidate pairs | 12,366 | 11,379 |
| Candidate reduction | 99.9806781% | 99.9822203% |
| Candidate recall | 100% | 100% |
| Automatic matches | 6,178 | 6,178 |
| Automatic precision | 100% | 100% |
| False automatic / hard-negative automatic | 0 / 0 | 0 / 0 |
| Review cases | 1,312 | 822 |
| Review yield | 62.652439% | 100% |
| True top / false top | 822 / 490 | 822 / 0 |
| Truth only in alternatives | 0 | 0 |
| No true candidate available | 490 | 0 |
| Product no-match in B / product no-match in A | 510 / 510 | 1,000 / 1,000 |
| Internal matcher A-only / B-not-auto-linked | 510 / 1,822 | 1,000 / 1,822 |
| Collisions / near ties | 0 / 0 | 0 / 0 |
| Deterministic groups | 3 | 3 |
| Batch-SAME eligible | 0 | 822 |
| Individual review after grouping | 1,312 | 0 |

After semantics, the remaining groups contain 795, 26, and 1 cases. They differ
only by generic margin/alternative/information bands and all have at least two
non-common strong positive fields, no collision, no near tie, no persistent-ID
conflict, and no strong contradiction. They are not automatically decided; the
human previews and confirms each group.

## 8. Frozen holdout before/after

The before artifact is the immutable SW-006 v0.2 report. The after artifact uses
explicit semantic mappings and the frozen v0.3 holdout config. The ordinary
product-default v0.3 config remains untuned; the separate holdout artifact records
its inherited `organizations-matcher-tune-1200-v1` evaluation provenance.

| Metric | Before | After |
| --- | ---: | ---: |
| Theoretical pairs | 1,089,936 | 1,089,936 |
| Candidate pairs | 4,132 | 5,356 |
| Candidate reduction | 99.620895% | 99.508595% |
| Candidate recall | 98.521047% | 98.521047% |
| Automatic matches | 253 | 169 |
| Automatic precision | 100% | 100% |
| False automatic / hard-negative automatic | 0 / 0 | 0 / 0 |
| Automatic-match recall | 28.782708% | 19.226394% |
| End-to-end recovery | 98.293515% | 98.521047% |
| Review cases | 598 | 681 |
| Review yield (derived true-top) | 97.993311% | 99.412628% |
| Unmatched matchable A rows | 7 | 8 |
| Top-1 true-candidate rate | 99.172577% | 99.763593% |

The lower automatic count is a recorded conservative regression caused primarily
by exact semantic email behavior rather than legacy partial email evidence. It
does not reduce candidate recall, end-to-end recovery, precision, or hard-negative
safety; retained truth moves to human review. No threshold was changed to recover
the automatic count.

Artifact: `evaluation/reports/review-generalization/holdout/report.json`.

## 9. Weak-ID before/after

The historical SW-005F artifact is candidate-level, so its before metrics cannot
truthfully supply matcher precision or review workload. The comparison remains
scoped accordingly.

| Candidate metric | v0.2 before | v0.4 after |
| --- | ---: | ---: |
| Theoretical pairs | 1,703,025 | 1,703,025 |
| Candidate pairs | 2,651 | 4,080 |
| Candidate reduction | 99.844336% | 99.760426% |
| True pairs retained | 1,093 / 1,101 | 1,094 / 1,101 |
| Candidate recall | 99.273388% | 99.364214% |
| Candidate misses | 8 | 7 |
| Hard negatives entering candidates | 6 | 6 |

Current matcher-only facts: 213 automatic matches, 100% automatic precision,
zero false automatic matches, zero hard-negative automatic matches, 859 review
cases, 99.185099% derived review yield, four unmatched matchable A rows, and
99.364214% end-to-end recovery.

Artifact: `evaluation/reports/review-generalization/weak-id/report.json`.

## 10. Multi-domain results

Threshold changes: **none**.

| Fixture | Candidate recall | Candidate reduction | Auto precision | Recall | False positives | False negatives | Review rate | Review yield | Collisions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Organizations/vendors | 100% | 97.551% | 100% | 100% | 0 | 0 | 2.857% | 100% | 0 |
| People/customers | 100% | 97.551% | 100% | 100% | 0 | 0 | 2.857% | 100% | 0 |
| Products | 100% | 71.347% | 100% | 100% | 0 | 0 | 0% | n/a | 0 |
| Facilities | 100% | 90.776% | 100% | 100% | 0 | 0 | 11.429% | 50% | 4 |
| Sparse legacy | 100% | 87.347% | 100% | 93.333% | 0 | 0 | 51.429% | 61.111% | 10 |
| Low information | 100% | 75.510% | n/a (0 auto) | 10% | 0 | 0 | 85.714% | 10% | 30 |

These are intentionally separate results. Low-information success is abstention:
no automatic matches, explicit weak-evidence status, and no fabricated certainty.
Artifact: `evaluation/benchmarks/generalization-v1/report.json`.

## 11. Review signatures, safety, and UX

Review-signature v1 sorts `(semantic family, evidence class, information class)`
tuples, then adds margin band, single/multiple alternative band, collision state,
and strong-contradiction state. Mapping IDs and dataset-specific labels do not
affect signature identity; labels are retained only for rendering actual fields.

Safety classes are quick decision, competing candidates, strong contradiction,
low-information noise, and individual review. No suggestion is emitted unless
every case in a group is eligible for the same action.

Batch SAME excludes collisions, near ties, strong contradictions, persistent-ID
conflicts, and cases lacking at least two non-common strong positive fields. A
retained low-ranked alternative alone is not treated as unresolved ambiguity when
the top margin is clear; alternatives remain previewable. Batch DIFFERENT requires
a single candidate and only low-information support, and excludes exact persistent
IDs and two-or-more strong positive fields.

The large-queue landing now shows Quick decisions, Competing candidates,
Individual review, and Deferred counts before grouped cards. Each card shows its
actual evidence pattern, exclusions, count, bounded paged preview, a confirmation
checkbox, and only the eligible action. The side-by-side workspace, alternatives,
specialist ambiguity sorting, defer/restore, and keyboard flow remain available.

Deterministic explanations are derived from real evidence: agreements, conflicts,
missing states, collision, and near-tie context. No AI prose determines identity.

## 12. Provenance, undo, and bounded delivery

Every batch-resolved pair receives an authoritative decision with origin
`human_batch_rule`, review signature version, group/signature ID, human decision,
candidate ID, evidence snapshot SHA-256, matcher, feature-pipeline,
candidate-engine, and evidence-plan versions, and timestamp. One undo entry records
the affected count and group. Existing merge/export dependency guards block unsafe
undo. Individual undo and defer/restore semantics are unchanged.

New bounded projections are a workload/group summary, group list, and paged group
preview capped at 100 items. They are derived from authoritative run state and do
not duplicate it. The browser never receives all group evidence, and existing
virtualized large queues remain bounded.

Run manifests now persist evidence-plan version/hash, candidate strategy/config
availability, review-signature version, and batch-decision count. Saving a policy
still never applies it, and batch identity never resolves field survivorship.

## 13. Versions and files changed

- Confirmed mappings: v3; semantic mapping contract/prompt/request: v3.
- Candidate engine/config: v0.4.0.
- Feature pipeline: v0.2.0.
- Matcher/config: v0.3.0.
- Evidence plan: v1.0.0.
- Review signature: v1.0.0.
- Workflow/run-manifest schemas were extended in place at their current pre-release
  contract path; historical benchmark artifacts were not overwritten.

Implementation spans matcher profiling/planning/scoring, candidate generation,
Python workflow models and CLIs, shared contracts/schemas/examples, API state and
routes, review and setup UI, tests, deterministic configs/artifacts, this report,
and ADR 0012. `git diff --stat` is the authoritative detailed file inventory.

## 14. Tests and verification

Added regressions cover exact/different persistent IDs, source-local exclusion,
entity versus contact semantics, unknown fallback, mutable contradiction, missing
strong identifiers and alternate routes, generic products/facilities, low-info
abstention, domain normalization, stable generic signatures, authoritative group
counts, bounded previews, explicit confirmation, SAME/DIFFERENT safeguards,
per-pair provenance, batch undo and dependency guards, and grouped UI behavior.

Final closeout results:

- Python: 132 passed.
- Contracts: 20 passed.
- API: 58 passed, 3 intentionally skipped.
- Web: 48 passed.
- TypeScript typecheck: passed.
- ESLint and Ruff: passed.
- `pnpm verify`: passed end to end.
- Production web build: passed; Vite built 141 modules and emitted the production
  bundle.
- New JSON configs/schemas: parsed successfully.
- `git diff --check`: passed (Git emitted only the repository's existing
  LF-to-CRLF checkout notices).

## 15. Performance impact

The 8K semantic analysis completed in 32.920617 seconds on the recorded local
environment. Candidate generation was 2.790968 seconds, normalization/index
construction 2.335079 seconds, feature cache 1.157521 seconds, feature extraction
15.305768 seconds, scoring 2.232735 seconds, and review grouping 0.014632 seconds.
Grouping is linear over review entries and signatures; it does not compare review
cases pairwise.

The traced frozen-holdout benchmark (1,044 × 1,044, 5,356 candidates) measured
21.381890 seconds for matching plus serialization, a 12,929,128-byte result, and
270,632,887 peak traced Python allocation bytes. `tracemalloc` includes Python
allocations from pre-load through serialization/evaluation and excludes native RSS;
these are fixture/environment measurements, not production capacity claims.

Artifacts: `evaluation/benchmarks/review-generalization-performance/benchmark.json`
and the review-workload analysis.

## 16. Regressions and limitations

- Exact semantic email handling moves 84 frozen-holdout cases from automatic to
  review (and changes other routing), reducing automatic-match recall while
  preserving/improving end-to-end recovery and safety. This is explicit.
- Candidate volume rises on holdout and weak-ID because v0.4 retains additional
  generic semantic routes. Recall is preserved/improved; further route reduction
  requires separate falsification rather than relaxed bucket caps.
- Synthetic fixtures are not real-customer accuracy claims. Sparse and
  low-information data intentionally remain review-heavy or unmatched.
- Frequency-aware score adjustment is deferred. Information class is useful for
  safety and grouping but is not a calibrated likelihood.
- Review groups do not add clustering/global assignment and do not resolve genuine
  one-to-many ambiguity automatically.

## 17. Why this is not overfit to the 8K fixture

Production rules refer only to confirmed semantic family, local profile and value
frequency, generic evidence class, margin, alternatives, and collision state—not
fixture column names, domain labels, row counts, or target review totals. The same
implementation is tested on six structurally different domains, a separately
seeded frozen holdout, weak identifiers, hard negatives, and generic renamed-field
signature equivalence. Thresholds are unchanged. The frequency score-scaling idea
considered during the work damaged held-out recovery and was removed rather than
tuned around the 8K fixture.

## 18. Verdict

**REVIEW GENERALIZATION PASS — HUMAN REVIEW IS TARGETED AND DATASET-ADAPTIVE**
