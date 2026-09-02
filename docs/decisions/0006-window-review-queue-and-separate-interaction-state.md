# ADR 0006: Window the review queue and keep interaction state local

- Status: Accepted
- Date: 2026-09-01

## Context

SW-006 holdout evidence routes many matchable A rows to human review. A credible
review product must handle thousands of queue summaries without mounting thousands
of complex rows. The matcher result and human decisions are authoritative server
state, while current selection, focus, filters, and expansion are ephemeral UI state.

## Decision

Derive a stable per-A `reviewQueue` and `reviewProgress` in the existing process-local
API `RunView`. Keep the unchanged candidate/evidence payload as the detail source.
Implement a focused fixed-row window in React that mounts the viewport plus five-row
overscan. Keep selection, active candidate, filter/search input, and focus in local
component state. Do not add a data-grid, Zustand, or React Query.

Use URL run and screen parameters to recover authoritative state from a still-live
API process. This does not claim durable persistence.

## Consequences

- Queue identity and progress semantics have one server-owned implementation.
- A deterministic 10,000-summary test can assert bounded row mounting without
  running 10,000 matcher jobs.
- Fixed row height keeps the implementation small but requires queue-summary text
  to remain clipped to the designed row.
- The current `RunView` still contains detailed candidate payloads; a separately
  paged detail endpoint can be considered only if measured payload size requires it.
- Durable persistence, collaboration, global assignment, and survivorship rules
  remain out of scope.
