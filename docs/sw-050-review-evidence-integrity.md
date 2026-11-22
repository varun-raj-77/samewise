# SW-050 — Review evidence belongs to the requested identity

## Risk

The review workspace previously parsed queue, candidate-detail, group-list, and group-preview JSON against strict schemas without checking that the returned identities matched the request. A valid-looking response for another run or candidate could be displayed and used as evidence for SAME/DIFFERENT. The component also temporarily retained pages and details from the previous run before cleanup effects executed.

## Implementation

- Reject a review page when its run ID, offset, page limit, filter, sort order, or search query differs from the requested queue.
- Reject a candidate-detail response unless its run ID and candidate ID match the requested pair.
- Reject group lists with the wrong run ID and previews with the wrong run ID, group ID, or first-page offset.
- Bind displayed review rows, candidate details, and group lists to the current authoritative run projection. Hide stale evidence immediately on run changes; asynchronous request cleanup still prevents late responses from updating state.
- Retain the existing decision mutation guards, collision inspection, off-page candidate navigation, and explicit identity-versus-survivorship separation.

## Acceptance

- Cross-run and cross-candidate responses fail closed; no identity decision can be submitted using their evidence.
- On a run switch, old review cards and SAME/DIFFERENT controls disappear synchronously while the new page loads.
- Existing queue, group preview, collision, keyboard, defer, and undo workflows continue to pass.
- Run repository verification, matcher benchmark gates, production build, and synthetic Chrome acceptance before merging.

## Limits

Response checks are not authentication or cryptographic provenance. The API must still enforce ownership and confirm identity decisions. This milestone changes no matcher algorithms, thresholds, assignments, survivorship policy, source records, production settings, or external infrastructure.
