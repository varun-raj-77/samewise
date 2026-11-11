# SW-049 — Bind conflict pages to the active reconciliation

## Problem

The Merge values workspace paginates unresolved and handled field conflicts. A fetched page was schema-validated but not checked against the requested run, status, or offset. After switching runs, the old React state could remain visible until effect cleanup. That could show obsolete values or offer action buttons for another reconciliation's conflict IDs.

## Scope

- Validate every response against the requested run ID, page offset, and expected resolved/unresolved status, including each returned row.
- Store loaded conflict pages together with the authoritative run projection and request offset. Render rows and action buttons only while those match the current run.
- Reset conflict pagination when the active reconciliation changes, without mutating source files or existing resolutions.
- Keep earlier in-flight page responses from surfacing after a run change.
- Preserve the existing manual resolution API, immutable source data, identity-versus-survivorship separation, and preview-token validation.

## Acceptance and verification

- A well-formed page from a different run, status, or offset is rejected, not rendered.
- While switching runs, old conflict values and manual decision controls are unavailable before the new response arrives.
- Existing valid unresolved and resolved conflict pages remain usable.
- The synthetic React regression tests, repository checks, matcher benchmarks, production build, and browser acceptance must pass before merge.

## Limits

This is a client-side context-integrity guard, not cryptographic provenance or an authorization boundary. The server remains responsible for enforcing run ownership and validating individual resolution requests. No matcher thresholds, survivorship policies, deployments, database setup, or production tests are changed.
