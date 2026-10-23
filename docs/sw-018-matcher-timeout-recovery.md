# SW-018 — Killable matcher deadlines and shutdown recovery

## Objective

Prevent an unresponsive Python matcher from leaving an opt-in matcher job in `running` indefinitely. A deadline must terminate the actual child process; timing out only an in-memory JavaScript Promise is insufficient.

## Changes

- The Python subprocess adapter enforces fixed safety deadlines: 60 seconds for profiling and 300 seconds for matching. These are initial conservative limits, **not** benchmark-derived SLOs. `createMatcherRunner({ profileTimeoutMs, matchTimeoutMs })` allows shorter deadlines in tests without introducing production environment settings.
- On deadline expiry, the adapter sends `SIGKILL`, settles the Promise with a typed `MatcherTimeoutError`, removes abort listeners, and clears the timer. Late child close/error events cannot overwrite a settled outcome.
- Opt-in jobs checkpoint `matcher_timed_out` as a safe failure code. No matcher result or job success is committed when the child times out. Users can explicitly retry up to the existing three-attempt limit.
- API close sends an AbortSignal to the active real matcher subprocess. The checkpoint remains `running` rather than pretending shutdown is an ordinary matcher failure. Startup recovery reclaims the interrupted attempt using the existing immutable source validation.
- The synchronous `/match` route retains its response contract and now benefits from the same real child deadline. A synchronous timeout still maps to a generic safe API error, rather than exposing internal exception or source content.

## Test gates

- `apps/api/tests/matcher-process.test.ts`: hung child killed, shutdown abort killed, finished profile deadline cleared, invalid timeout rejected.
- `apps/api/tests/match-jobs.test.ts`: timed-out job has no result and can be explicitly retried; API shutdown aborts an active match; persisted attempt is reclaimed on restart.
- `pnpm verify` plus production web build. No matcher model, blocker, score, threshold or benchmark changed.

## Important boundaries

- This is **single-process**, not a distributed lease. Simultaneous API instances are not safe as independent worker owners.
- `SIGKILL` terminates the directly spawned Python process when the host OS honors the request. A stubborn OS-level child or a process spawned by Python requires separate supervision; this does not claim a process-tree kill on every platform.
- The injected `MatcherRunner` interface is a testing seam. A custom runner that ignores AbortSignal is not physically killable; the production Python adapter is.
- A 300-second matching deadline may need adjustment after measuring legitimate large-input workloads. Do not advertise it as a performance target.
- Existing snapshot storage is durable only to the degree of its backing repository. Deployment replacement with ephemeral files, multi-instance ownership, retention, and privacy controls remain separate gates.

## Exclusions

No external queue, database configuration, hosted workers, public UI redesign, cancellation endpoint, production fault injection, or manual deployment. No changes to source datasets, semantic mapping, identity/survivorship, or matcher scoring.
