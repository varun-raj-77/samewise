# ADR 0013 — Durable run repository boundary

## Status

Accepted for SW-015A.

## Context

Samewise originally kept the authoritative reconciliation workflow in a process-local `Map` and wrote uploaded CSVs only to the API process filesystem. That was appropriate for the first complete product slice, but an API restart could remove the run even though the browser still held a run ID. The public demo exposed this failure mode directly.

Durability is broader than the final matcher result. A recoverable run must retain source fingerprints and bytes, confirmed mappings, optional semantic proposals, matcher evidence, individual and batch identity decisions, deferred review state, undo provenance, field conflicts, merge policy, preview tokens, rule application state, and export-relevant versions.

Adding a database, job queue, worker, and object store at once would mix several independent architecture changes and make failure semantics harder to review.

## Decision

Introduce a `RunRepository` boundary owned by the API.

SW-015A provides:

- an in-memory adapter for focused tests and future dependency injection;
- a file-backed adapter using only the Node.js standard library;
- versioned state envelopes;
- atomic state-file replacement through write-then-rename;
- immutable source copies stored separately from mutable run state;
- SHA-256 validation before persisting or rematerializing source bytes;
- API startup hydration before requests are served;
- persistence after every successful run mutation, including review and merge previews;
- rematerialization of matcher input files from repository-owned source bytes;
- startup failure when persisted state or source fingerprints are inconsistent.

The working `.samewise-data/<run-id>/` CSV files remain disposable matcher inputs. The repository copy is the recovery source.

The default file-backed repository lives under `.samewise-data/_run-store/`.

## Ordering invariant

When a dataset first becomes part of a run, Samewise persists immutable source bytes before persisting state that references that dataset. A crash may therefore leave an unreferenced source copy, but must not leave committed run state that references missing source bytes.

Mutable run state is then persisted after each successful mutation before the response is serialized to the client.

## Non-goals

SW-015A does **not** claim:

- durability across ephemeral deployment replacement;
- safe concurrent writers across multiple API processes;
- database transactions;
- optimistic browser revision enforcement;
- background matcher jobs;
- retries or worker leases;
- object storage.

The file adapter is intentionally a proving implementation of the repository contract, not the final hosted storage architecture.

## Follow-up

SW-015B will add the deploy-safe PostgreSQL adapter and revision/CAS semantics. It should preserve the repository contract and restart tests rather than rewriting workflow semantics again.

## Consequences

Positive:

- process restart recovery becomes testable end to end;
- source bytes are recoverable independently of working matcher paths;
- persistence is separated from matching and product semantics;
- later PostgreSQL adoption has a clear seam;
- preview/undo/review state cannot be accidentally omitted without failing restart tests.

Costs and limitations:

- file-backed storage duplicates source bytes;
- complete matcher results are currently serialized with run state;
- snapshot writes become more expensive as run evidence grows;
- a failed persistence write can leave the live process ahead of the last durable snapshot;
- the file adapter is not safe for multiple API writers.

Those limitations are intentionally carried into SW-015B/SW-024 rather than hidden.
