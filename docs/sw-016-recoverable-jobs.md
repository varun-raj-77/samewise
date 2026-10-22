# SW-016 — Recoverable matcher jobs (opt-in)

## What changed

Samewise can now submit an asynchronous matcher job for an existing reconciliation without changing the synchronous `POST /api/runs/:runId/match` contract that the current web UI uses.

- `POST /api/runs/:runId/match-jobs`, with an `Idempotency-Key` header of 8–128 safe characters, returns the durable job (HTTP 202 while queued/running, or 200 when an identical request already reached a terminal state).
- `GET /api/runs/:runId/match-jobs/current` reports queued, running, succeeded, or failed.
- `POST /api/runs/:runId/match-jobs/:jobId/retry` explicitly retries a failed attempt (maximum three total attempts).

The idempotency key is stored only as a SHA-256 digest. Job metadata, attempts, and the final matcher result share the existing versioned run snapshot and revision/CAS repository boundary. A completed attempt persists the matcher result and job success together, so a crash cannot show a committed success without its result.

A single API-process worker runs the existing matcher. It checkpoints `queued → running`, computes from immutable source copies, and checkpoints `running → succeeded|failed`. Run mutations are blocked while a matcher job is queued, running, or failed, keeping retry inputs frozen. After success, normal review and field-resolution mutations are available; the legacy rematch endpoint remains blocked. Read-only job polling remains available. Failed jobs store only a closed, non-sensitive error code, never source rows or Python exception text.

On startup, `queued` jobs are scheduled again, while jobs left `running` after an interrupted process are marked `queued` and re-executed if fewer than three attempts were started. Attempts exhausted on recovery become `failed` with `retry_exhausted`. Successful jobs are never rerun.

## Reliability boundaries

- **Opt-in only.** The current web flow uses the existing synchronous API, and this patch does not add a worker service, Redis, public job UI, or frontend polling.
- The worker is **process-local**. It tolerates a single-process restart only when its `RunRepository` survives the restart.
- On the current public-demo ephemeral filesystem, deployments can still discard files; this code does **not** claim durability across a deployment replacement.
- PostgreSQL support is behind `DATABASE_URL`, which this patch does not configure. Cross-process worker ownership/leases and externally orchestrated retries are not solved; do not scale this process-local worker horizontally and claim distributed exactly-once execution.
- Neither physical cancellation nor worker timeouts are implemented here. A hung matcher can remain running until process termination; SW-017 failure injection and later worker leases/timeout handling remain separate.
- No matcher scoring/threshold/config logic changed; any repeat attempt recomputes from versioned mappings and immutable file bytes.
- Do not activate persistent public retention without access controls and explicit retention/deletion behavior.

## Acceptance checks

1. Duplicate submissions with the same key retain one job identity and do not compute twice.
2. A different key cannot create a competing job on the same run.
3. Mapping/identity mutations are refused while a queued/running job exists.
4. A running attempt interrupted by process shutdown is reclaimed from persisted source bytes and the attempt count increases.
5. Only explicit retries follow an ordinary matcher failure; retry cap is enforced.
6. Successful output remains a standard Samewise result, with no change to identity/survivorship semantics.
7. `pnpm verify` passes including `apps/api/tests/match-jobs.test.ts` and PostgreSQL integration tests.

## Future work

SW-017: deliberate worker-crash, slow/hung matcher, persistence-failure, duplicate-delivery, and shutdown/lease fault injection. A later measured reliability gate can select a real queue/worker service and distributed leases, but those are intentionally excluded now.
