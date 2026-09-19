# Final result-state consistency audit

Date: 2026-09-19  
Verdict: **RESULT-STATE CONSISTENCY PASS — READY TO DEPLOY**

## Root cause

The Python matcher deliberately emits `onlyB` as every B record without an
automatic link. Before identity review is finished, that internal projection
includes B records in unresolved review candidates. The API preserved it for
exports and then used its raw length for the compact product label “No match found
in Dataset A.” On the accepted public workload this produced 1,822 = 1,000 genuine
B-only records + 822 B records currently paired with unresolved A review cases.

The 1822 count therefore did double-count unresolved review state in the primary
user summary. Candidate, scoring, threshold, evidence-plan, comparator, and review
safety behavior were not involved and were not changed.

The audit also found that an automatic rank-one match could enter the review queue
when lower-ranked alternatives were retained. The match remained effective, but
the queue projection was inconsistent. Untouched automatic matches now stay out
of review; rejecting the automatic candidate still advances to an undecided
alternative under the existing decision model.

## Authoritative workflow states

Primary summary states are derived from effective links, unresolved decisions,
and exhausted candidates. They are mutually exclusive per source record:

| State | A representation | B representation | Product bucket |
| --- | --- | --- | --- |
| Automatic or human SAME | effective linked A | effective linked B | Matched automatically / confirmed |
| Unresolved review | unresolved A review item | every undecided candidate B reserved by that item | Need your review |
| Deferred | deferred A review item | undecided candidate B records remain reserved | Deferred review, included in unresolved review total |
| Human DIFFERENT, alternative remains | A stays unresolved and advances | rejected B is released; undecided alternative B stays reserved | Need your review |
| Human DIFFERENT, all alternatives exhausted | A becomes no-match | rejected candidate B records become no-match unless reserved or matched elsewhere | No match found |
| Collision/competition | competing A records remain unresolved | shared candidate B remains reserved once | Need your review |

The A-side and B-side sets are derived symmetrically. A record is no-match only
when it is neither effectively linked nor unresolved review. B follows the same
rule; it is excluded from product no-match while any unresolved candidate link
reserves it. Counts are sets, so a shared collision B is not duplicated.

## Code changes

- `WorkflowStore.view()` now derives unresolved A/B sets before the compact result
  summary and excludes those sets from primary `onlyA`/`onlyB` counts.
- Internal `RunView.onlyA`, `RunView.onlyB`, readiness/export counts, reconciliation
  rows, trusted output, identity decisions, and manifest behavior are unchanged.
- Review-queue construction now excludes an untouched automatic rank-one match
  even when the matcher retained alternatives.
- Results copy now says “Matched automatically / confirmed,” accurately covering
  system matches and human SAME decisions.
- The workload harness records separate product no-match counts and raw matcher
  projections. Its summary labels no longer present internal `onlyB` as a final
  no-match claim.

## Export and internal compatibility

The reconciliation report continues to preserve unresolved, deferred, human
DIFFERENT, and internal source-only audit rows. The trusted output remains blocked
while identity review is unresolved, so its source-only rows are produced only
after candidate decisions are exhausted. Historical `onlyA`/`onlyB` arrays and
manifest counts are not redefined. They remain technical “not effectively linked”
projections rather than primary workflow claims.

## Deterministic public workload

The accepted matcher output is unchanged:

- automatic matches: 6,178
- unresolved review cases: 822
- candidate pairs: 11,379
- candidate recall: 100%
- automatic precision: 100%
- false automatic matches: 0

The product summary on that same state changes as follows:

| Product label | Before audit | After audit |
| --- | ---: | ---: |
| Matched automatically / confirmed | 6,178 | 6,178 |
| Need your review | 822 | 822 |
| No match found in Dataset B | 1,000 | 1,000 |
| No match found in Dataset A | 1,822 | 1,000 |

The raw matcher projection remains 1,000 A-only and 1,822 B-not-auto-linked for
compatibility. The 822 unresolved B records are now reserved by review rather than
also presented as no-match.

For the historical pre-generalization queue, mutually exclusive product no-match
counts are 510/510 while raw matcher projections remain 510/1,822. The other 490
source-only pairs remain review work in that historical state because the old
candidate behavior had not yet been resolved.

## Tests

Focused tests cover automatic matches with retained alternatives, unresolved and
deferred review, human SAME, exhausted DIFFERENT, DIFFERENT with a viable
alternative, collision symmetry, batch SAME versus individual SAME, batch
DIFFERENT versus individual DIFFERENT, undo, and the full deterministic 8K
summary. The 8K test regenerates the committed benchmark config and derives the
counts; it does not inject the expected summary into production code.

## Verification

- `pnpm verify`: passed (lint, typecheck, 126 JavaScript/TypeScript tests, Python
  lint, and 133 Python tests; 3 intentionally skipped integration/performance
  tests remain skipped).
- `pnpm -r --if-present build`: passed; the production web bundle was generated.
- Public review workload rerun: 6,178 automatic, 822 review, 1,000/1,000 product
  no-match, 1,000/1,822 raw matcher projections, 100% candidate recall, 100%
  automatic precision, and zero false automatic matches.
- Multi-domain generalization rerun: passed all configured thresholds with no
  matcher-metric changes.
- `git diff --check`: passed.

## Remaining ambiguity

`onlyB` in the matcher result and unresolved reconciliation/manifest artifacts is
an internal not-auto-linked projection, not a claim that identity absence has been
proved. That historical representation remains intentionally broader than the
product no-match state. The trusted export cannot be produced until unresolved
identity is cleared, so no ambiguity crosses the trusted-output boundary.
