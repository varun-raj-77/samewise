# SW-017 — Matcher-job fault injection and bounded checkpoint recovery

## Objective

Prove the failure semantics of the SW-016 opt-in matcher-job workflow before introducing a distributed worker, queue, or persistent public storage. This milestone is test-first and does **not** alter the existing synchronous reconciliation UI.

## Delivered scope

- Fault-injectable in-memory run repository used only by API tests: selected state-save failures and a deliberately corrupted authoritative source read.
- A bounded, process-local retry after a transient failure to persist the `queued -> running` checkpoint. The handler backs off (100 ms then 200 ms), at most two extra start-checkpoint attempts after the initial failure.
- Explicit verification that failed `running -> succeeded` persistence does not expose a successful job or a matching result that was never committed.
- Verification that retries resume only after explicit user action when execution fails, and that corrupted persisted source data is rejected before matcher execution.
- Verification that repeated persistence failures leave a job queued, with no tight retry loop and no invented completed result.

## Acceptance criteria and tests

Run `pnpm verify` (including `apps/api/tests/match-jobs.test.ts`). Required assertions:

1. A single transient start-checkpoint write failure recovers with **one** matcher invocation and a persisted attempt count of one.
2. A failed success-checkpoint write leaves no visible success or result. An explicit retry may recompute successfully and increments attempts.
3. A persistent start-checkpoint outage executes at most three bounded start-save attempts per scheduled cycle and does not run the matcher.
4. A corrupted source read fails before scoring and an uncorrupted explicit retry succeeds.
5. Existing restart, idempotency, retry-cap, immutable-source, and post-match provenance tests continue to pass.
6. The web build and unrelated repository verification stay green.

## Boundaries and risks

- The retry counter and timer exist **only in one API process**. A queued job surviving a long storage outage requires a subsequent identical-key submission or restart/recovery after storage returns. This is not a distributed lease, exactly-once delivery, or an external queue.
- The background Python runner still lacks a hard killable timeout. A hung process may remain running until process termination. Do not claim cancellation or a general-purpose watchdog from this patch.
- Fault tests use injected in-memory storage, never production data or production endpoints.
- A lost success checkpoint intentionally requires recomputation, since no authoritative result was committed. Matcher determinism and frozen immutable inputs remain essential.
- Public persistence, credentials, access control, retention, and deployment alignment are separate authorization gates.

## Exclusions

No PostgreSQL configuration, hosted worker, external queue, new environment variables, UI redesign, live production fault injection, benchmark score changes, or deployment commands.
