# ADR 0010: Bound API projections while retaining authoritative evidence

## Status

Accepted for SW-012.

## Context

The 10K matcher result is 56,892,493 bytes. The browser needs counts and bounded
lists for ordinary screens, but decisions, evaluation, survivorship, exports, and
provenance require complete deterministic evidence. Recomputing evidence on demand
would create a second version-sensitive execution path.

## Decision

Keep the validated `MatcherResult` as process-local authoritative state. Expose
versioned, purpose-specific `RunSummary`, `ResultsPage`, `ReviewQueuePage`,
`ConflictPage`, and `CandidateEvidenceDetail` contracts. List endpoints use offset
paging with default 50, maximum 100, and explicit deterministic ordering. Candidate
detail returns the original retained evidence rather than reconstructing it.

Exports and human-evaluation evidence continue to derive from the authoritative
internal `RunView`, never from browser pages. Mutation responses return compact run
summaries and clients reload the affected page.

## Consequences

Ordinary 10K browser responses fall below 90 KB while full evidence remains
available on selection. Matching and export semantics remain unchanged. The API
still retains a large in-memory authoritative object, and restart still loses run
state; paging must not be presented as durability or a server-memory improvement.
Future retention normalization requires separate measurement and equivalence tests.
