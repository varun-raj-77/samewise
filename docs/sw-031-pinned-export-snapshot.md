# SW-031 — Snapshot-pinned export API

## Problem proved from the implementation

Samewise serves reconciliation CSV, trusted merged CSV and provenance manifest
from three independent `WorkflowStore.exportSnapshot(runId)` calls. They are
deterministic for a single run state, but a SAME/DIFFERENT decision, undo or
survivorship resolution **between requests** changes the state and its hashes.
Separately downloaded files can therefore be valid individually yet inconsistent
as a set. The SW-030 verifier should reject such a mixed bundle, but does not
prevent its accidental creation.

## Bounded fix

All three existing GET endpoints now emit `X-Samewise-Export-Snapshot`
equal to the manifest's canonical authoritative-state SHA-256. Clients can
optionally supply this SHA as `?expectedSnapshot=` on subsequent downloads.
The API computes the artifact and its SHA from the *same locked read view*.
If a decision changes the state, the request fails with HTTP 409
`stale_export_snapshot` and returns **no export bytes**. Invalid and duplicate
tokens fail with HTTP 400. Responses mark `Cache-Control: no-store`.

No old state is retained. A 409 means discard/re-download the entire set;
the API does not serve or reconstruct an older export snapshot.

## Consumer recipe

1. `GET /api/runs/:runId/manifest`. Keep its
   `X-Samewise-Export-Snapshot` SHA and the manifest's declared artifacts.
2. `GET /api/runs/:runId/export?expectedSnapshot=<SHA>`.
3. If `run.status === "trusted_ready"`, also
   `GET /api/runs/:runId/trusted-export?expectedSnapshot=<SHA>`.
4. Any 409 means **do not use the partially downloaded set**. Restart from
   step 1 and re-download all artifacts. Verify SHA-256 and byte length
   against the manifest (SW-030 provides a separate offline verifier).
5. Preserve sensitive downloaded files under the user's own retention policy.

For legacy clients, calls without `expectedSnapshot` are unchanged except
for the added response headers. The existing web app still uses unpinned
single-file downloads; UI integration is deliberately deferred to avoid
overlapping SW-028 PR #18.

## Acceptance criteria / tests

- Manifest and reconciliation agree on the exact pin and artifact hash.
- Human identity change invalidates prior tokens across all three endpoints.
- Once field resolution makes trusted output ready, pinned trusted CSV bytes
  match the manifest; clearing a resolution invalidates that token.
- Invalid, repeated and cross-run tokens fail with no export content.
- Existing individual endpoint response formats and readiness errors remain.
- Repository verification, Python tests, all existing matcher benchmarks and
  web production build pass.

## Limits and exclusions

This guards *state consistency within a cooperating client*, not tampering
with manifest/bytes, publisher authenticity, underlying matcher accuracy,
or unauthorized data access. No database migration, object store, in-process
snapshot cache, ZIP packaging, new dependency, source-file mutation, change
to matcher thresholds/assignment policies, UI change, manual deployment,
Railway access or live production tests.
