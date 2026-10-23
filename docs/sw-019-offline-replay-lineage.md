# SW-019 — Offline matcher replay and lineage verification

## Objective

Prove whether a stored matcher result can be reproduced from the exact immutable source bytes and the currently installed matcher code, **without** rewriting identity decisions, field resolutions, exports, or authoritative run state.

This is an offline maintenance check, not a new public API.

## Usage

From a developer environment with Node 24, pnpm, and the matcher Python virtual environment installed:

```sh
pnpm --filter @samewise/api exec tsx src/replay-cli.ts --data-root /absolute/path/to/.samewise-data --run-id run-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

The CLI reads only a **file-backed** run under `_run-store`; it refuses a `DATABASE_URL` environment and does not contact production infrastructure. It selects the local `services/matcher/.venv` interpreter when `SAMEWISE_PYTHON` is not already set. No API key is needed.

## What is checked

1. Load a versioned persisted state snapshot. Reject missing matches and an incompatible recorded matcher version.
2. Read both immutable source blobs from the run repository and verify SHA-256 against each recorded dataset profile. Reject a mismatch before matching.
3. Create private temporary CSV copies (rather than trusting the working CSV paths); use frozen confirmed mapping entries with `useForMatching`.
4. Call the same Python matcher adapter under its SW-018 hard timeout, comparing SHA-256 of canonicalized matcher-result JSON against the stored result. Object key order is sorted; array order remains significant.
5. Return a digest-only JSON report, including both source hashes, stored revision, matcher versions, and `identical` or `different`. No raw row content, model prompts, decision payloads, filesystem paths or uploaded filenames are emitted.
6. Delete temporary source copies in a `finally` clause, including when the matcher throws. On mismatches CLI exits nonzero. A fatal process termination may still leave private temp files; this is not a zero-retention guarantee.

## Meaning and limits

`identical` means **one** freshly computed matcher result matches the stored one byte-for-byte after canonical JSON serialization, for the exact versions and inputs used in the check. It is not proof that the algorithm is nondeterminism-free on every platform or that all past configurations are executable. `different` is measured drift, not automatically proof of a defect: changes to dependencies or algorithms under an unchanged version can cause it.

The replay covers the **matching stage only**, not AI semantic schema suggestions and not human identity decisions or survivorship. Those are stored evidence, not silently recomputed judgments. The comparison detects matcher-result drift, not whether the human's recorded decisions were good or whether an accepted identity is objectively true.

It is intentionally **not** an HTTP endpoint: without authentication, a public replay action could give anonymous clients a costly matcher-compute primitive. PostgreSQL snapshots are not supported by this local CLI; a future authorized back-office workflow can be designed separately.

## Tests and acceptance

`apps/api/tests/matcher-replay.test.ts` tests exact equality, changed matcher result, immutable source corruption, incompatible versions, missing result, preservation of historical state and source bytes, sanitized report output, and cleanup after matcher failure.

Acceptance: CI `pnpm verify` and production web build pass; no matcher behavior or scores, no public API/UI, no storage schema migration, no production deployment or hosted infrastructure mutation.

## Future follow-up

Retain richer run-specific code/config digests for cross-version replay rather than treating a stable version name as complete proof of the old binary. Add a bounded authenticated verification workflow only when access control and measured usage justify it.
