# SW-032 — Snapshot-pinned browser export downloads

## Objective

Connect the existing Samewise export screen to SW-031's optional
`expectedSnapshot` read-consistency guard, without losing the SW-028 review
reliability improvements already present on this stacked branch.

## Behavior

- First successful file download for a run captures its
  `X-Samewise-Export-Snapshot` SHA when the backend supports SW-031.
- Subsequent reconciliation, manifest and trusted file downloads for that
  same run include `?expectedSnapshot=<captured SHA>`.
- HTTP 409 `stale_export_snapshot` stops the download, clears that session's
  pin and shows a clear instruction to download **all files again**. No hidden
  retry and no acceptance of a mismatched set.
- A successful HTTP 200 that omits or changes a previously pinned SHA is
  also rejected; the browser never silently saves mixed-state files.
- Downloads are serialized to avoid racing multiple clicks.
- Starting a new run does not reuse the prior run's pin.
- Older APIs without the SW-031 response header keep legacy individual-file
  behavior. In that case, snapshot-consistency protection is **not available**,
  and the product must not claim otherwise.

## Dependencies / merge order

This PR is stacked **on SW-028 PR #18**, because that branch already changes
`App.tsx` and review UI. It also requires **SW-031 PR #21** on the backend
for protection to be effective. It must not be merged to master directly while
these dependencies are outstanding. After upstream PRs are safely merged,
rebase onto the verified latest master, rerun all checks, then request separate
exact-head approval.

SW-029 #19 and SW-030 #20 remain independent. Experimental #13 is not merged.

## Acceptance / evidence

- Browser tests verify first-download pinning across the remaining file types.
- Stale 409 does not trigger an automatic retry or save bytes.
- Missing/different 200-response token after pinning fails closed.
- Legacy no-header first download remains compatible.
- Repository tests/typechecks, existing matcher benchmarks and production
  web build remain green; exact-head Vercel status is checked independently.

## Exclusions

No changes to matcher, assignment, identity semantics, survivorship, CSV or
manifest bytes, backend routes, storage, authentication or infrastructure.
No bundling/ZIP feature or claim of simultaneous multi-file browser download.
No Railway access, manual redeploy, production tests or merge.
