# SW-047 — Keep result evidence bound to its reconciliation

## Problem and acceptance boundary

The Results workspace fetches a bounded result page and, on demand, an
explanation for one Dataset A row. Schema validation alone permits a
well-formed response belonging to another run, page offset, or row. Displaying
that response under the current run could misrepresent what the matcher
actually recorded, and a displayed candidate row is also a navigation target.

Changes to the active run, page, or review progress can also happen before
React's cleanup effects have cleared the previous response. An expanded row
from a previous reconciliation must not carry into the new reconciliation,
even if the two datasets happen to reuse the same source row identifier.

## Behavior

- Check the parsed result response's `runId` and requested page `offset`
  before exposing it to the UI.
- Check an explanation response's `runId` and `aRowId` against the selected
  row before displaying matcher evidence.
- Scope rendered pages to the active run, offset, request generation, and
  review-progress revision; scope explanation selection and loading state to
  the active run and row.
- Start at page zero when the active reconciliation changes, even if the
  workspace instance is reused.
- Surface load failures and retry controls outside the collapsed result
  inspector, so a user can see them without first expanding the panel.

Mismatched responses fail closed. The user can retry; the UI does not guess
that a different run's evidence is applicable. Nothing here changes the
authoritative matcher, identity decision, or source records.

## Verification and reviewer focus

`apps/web/src/ResultsWorkspace.test.tsx` covers the existing bounded-page
flow plus a foreign-run page, wrong offset, foreign-row explanation, same-ID
run switch, and the page reset on run switch. The first three mismatch cases
were observed failing before the fix.

Reviewers should check the async lifecycle (including retry), whether all
visible result controls are correctly scoped, and that loading/errors remain
understandable. The production web build and the repository's full verification
command are gates. The change neither accesses Railway nor tests production.

## Risks and exclusions

The workspace trusts the API to supply syntactically valid run projections,
but now rejects responses whose identifiers contradict the request. It does
not cryptographically prove response provenance. There is no change to backend
paging, scoring, evaluation, survivorship, export, schema versions, or
deployment infrastructure. Cross-run page reset does not clear server state.
