# API reference

The Fastify API is an internal, pre-release product boundary. The web client calls relative `/api` paths; local Vite proxies them to `http://localhost:3000`. Requests and responses are validated against the contracts in `packages/contracts`. A run exists only in the current API process.

## Run and matching

| Method | Path | Action |
| --- | --- | --- |
| GET | `/api/health` | API health |
| POST | `/api/runs` | Create run |
| POST | `/api/runs/:runId/datasets/:side` | Upload CSV bytes for A or B |
| GET | `/api/runs/:runId` | Compact run summary |
| PUT | `/api/runs/:runId/mappings` | Save validated confirmed mappings |
| POST | `/api/runs/:runId/mapping-suggestions` | Request metadata-only structured proposal |
| PATCH | `/api/runs/:runId/mapping-suggestions/:suggestionId` | Review one proposal |
| POST | `/api/runs/:runId/match` | Run candidate generation and matcher |

CSV upload uses a CSV content type and `X-File-Name`; the current development limit is 2 MiB per file. Only confirmed mappings enter matching.

## Results and identity review

| Method | Path | Action |
| --- | --- | --- |
| GET | `/api/runs/:runId/results` | Bounded result page |
| GET | `/api/runs/:runId/review` | Filtered, sorted, bounded review page |
| GET | `/api/runs/:runId/review-groups` | Derived group summaries |
| GET | `/api/runs/:runId/review-groups/:groupId` | Bounded group preview |
| POST | `/api/runs/:runId/review-groups/:groupId/decisions` | Explicit eligible batch decision |
| GET | `/api/runs/:runId/candidates/:candidateId` | Full retained candidate evidence |
| POST | `/api/runs/:runId/candidates/:candidateId/decisions` | Individual Same/Different |
| PATCH | `/api/runs/:runId/review-items/:aRowId` | Defer or restore |
| POST | `/api/runs/:runId/review-undo` | Guarded undo |

Results and conflict lists use stable ordering. Review applies filter, sort, and search before paging. List pages default to 50 items and are capped at 100; candidate detail is fetched on demand. Group decisions record one provenance entry per affected pair.

## Merge and export

| Method | Path | Action |
| --- | --- | --- |
| GET | `/api/runs/:runId/conflicts` | Bounded field-conflict page |
| POST | `/api/runs/:runId/conflicts/:conflictId/resolutions` | Manual Use A, Use B, or Keep Both |
| DELETE | `/api/runs/:runId/conflicts/:conflictId/resolution` | Explicitly clear manual resolution |
| PUT | `/api/runs/:runId/survivorship-policy` | Save policy without applying |
| POST | `/api/runs/:runId/survivorship-preview` | Preview one configured rule |
| POST | `/api/runs/:runId/survivorship-apply` | Explicitly apply one rule |
| POST | `/api/runs/:runId/merge-plan-preview` | Preview a field-level plan |
| POST | `/api/runs/:runId/merge-plan-apply` | Apply previewed plan with token |
| GET | `/api/runs/:runId/export` | Always-available reconciliation CSV after matching |
| GET | `/api/runs/:runId/trusted-export` | Readiness-gated merged CSV |
| GET | `/api/runs/:runId/manifest` | Snapshot and exact CSV hashes |

The trusted endpoint returns a readiness error while identity or required field conflicts remain unresolved. Saving a policy and previewing it are non-mutating; application is separate. For field semantics and provenance, see [SW-008](sw-008-survivorship.md) and [SW-010](sw-010-export-provenance.md).

## Evaluation

`GET /api/evaluations` lists checked-in snapshots; `GET /api/evaluations/:evaluationId`, `GET /api/evaluations/:evaluationId/comparison/:otherId`, and `GET /api/evaluations/:evaluationId/errors` inspect them. `GET /api/runs/:runId/evaluation-evidence` exposes human review evidence separately. Evaluation truth never enters ordinary run matching.
