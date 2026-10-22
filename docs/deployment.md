# Public demo deployment

Canonical UI: https://trysamewise.vercel.app. The frontend's relative `/api` requests are rewritten by `apps/web/vercel.json` to the Railway Fastify API. `GET /api/health` is the health endpoint used through that proxy.

## Public demo architecture

- Vercel hosts the React/Vite frontend.
- Railway runs the Fastify API and the installed Python matcher together in one container.
- The frontend calls relative `/api/...` URLs through the configured Vercel rewrite to Railway.

This is a constrained portfolio demo, not a multi-user production SaaS.

## Run storage and rollout

Without `DATABASE_URL`, the API uses a local `FileRunRepository` below `.samewise-data/_run-store`. This survives only when that directory survives; Railway's current ephemeral filesystem is **not deployment-durable**. No persistent Railway volume is used.

When `DATABASE_URL` is explicitly configured, the API selects `PostgresRunRepository` and creates/validates the initial schema on startup. PostgreSQL retains run snapshots and immutable uploaded source bytes, while Python matcher working files can be rematerialized. A database outage fails startup or mutations; **the API never silently falls back to local disk when DATABASE_URL is set**.

**Do not enable persistent storage on the public demo yet.** The current demo has no authenticated per-run ownership, deletion/retention controls, or agreed lifecycle for potentially sensitive uploads. A permanent database changes the privacy risk; access controls, bounded retention, cleanup, and an explicit hosted restart/rollback drill are deployment gates. A database provisioned but not connected does not make active runs durable.

For local, disposable integration tests use `SAMEWISE_TEST_DATABASE_URL` against a dedicated test database; this must never point to production. GitHub Actions runs PostgreSQL 17 as an ephemeral service to verify the adapter and its revision checks.

The current API process still hydrates all snapshots at startup and performs synchronous matching. It has no job queue or multi-worker coordination. PostgreSQL commits revision-checked run snapshots and their newly uploaded source bytes in one transaction: stale writes roll back without leaving orphaned immutable blobs. A stale request receives `409 stale_run_revision` and must refresh. Long-lived multi-instance availability and end-to-end recovery still require subsequent hardening.
