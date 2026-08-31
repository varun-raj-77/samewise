# Samewise

Samewise takes two messy CSV datasets, determines which records refer to the same real-world entity, asks a human about uncertain candidates, and produces an explicit reconciliation export.

SW-003 implements the first complete local-development product loop:

1. Upload immutable Dataset A and Dataset B CSV files.
2. Inspect Python-generated profiles and limited representative samples.
3. Manually pair columns as either identity evidence or post-identity comparison fields.
4. Run the versioned `baseline-matcher-v0.1.0` matcher.
5. Inspect Matched, Needs Review, Only A, and Only B results plus per-field evidence.
6. Record **Same entity** or **Different entity** for a candidate.
7. Only after identity confirmation, explicitly choose **Use A** or **Use B** for a conflict.
8. Export a formula-safe reconciliation CSV that preserves unresolved values honestly.

Identity and survivorship are separate state transitions. Confirming identity never chooses a field value.

## Prerequisites

- Node.js 24 LTS
- pnpm 11 (Corepack is recommended)
- Python 3.13
- uv

Runtime expectations are recorded in `.nvmrc`, `.python-version`, `package.json`, and the lockfiles.

## Get started

```text
pnpm install
uv sync --project services/matcher --locked
pnpm dev
```

The web app runs at `http://localhost:5173` and proxies `/api` to the Fastify API at `http://localhost:3000`. The API invokes the Python matcher as a subprocess. Set `SAMEWISE_PYTHON` to an explicit Python executable when `python` is not on `PATH`.

For the development demo, upload only these visible fixture inputs:

```text
fixtures/corrupted/organizations/organizations-dev-v1/dataset_a.csv
fixtures/corrupted/organizations/organizations-dev-v1/dataset_b.csv
```

Do not use the fixture's canonical, ground-truth, provenance, schema-truth, or hard-negative artifacts in product operation. They remain evaluation-only.

Uploaded bytes are written once beneath the ignored `.samewise-data/<run-id>/` directory under generated filenames. SHA-256 fingerprints are stored in the run profile. Mapping, result, decision, and resolution metadata is process-local and is lost when the API restarts.

## API workflow

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/runs` | Create a process-local run |
| `POST` | `/api/runs/:runId/datasets/:side` | Upload raw CSV bytes for side `A` or `B` |
| `GET` | `/api/runs/:runId` | Read current run state |
| `PUT` | `/api/runs/:runId/mappings` | Save validated manual mappings |
| `POST` | `/api/runs/:runId/match` | Invoke the Python baseline matcher |
| `POST` | `/api/runs/:runId/candidates/:candidateId/decisions` | Record Same/Different identity |
| `POST` | `/api/runs/:runId/conflicts/:conflictId/resolutions` | Record Use A/Use B resolution |
| `GET` | `/api/runs/:runId/export` | Download reconciliation CSV |

Uploads use a CSV content type plus an `X-File-Name` header. The development limit is 2 MiB per file.

## Baseline matcher behavior

The matcher explicitly compares every A row with every B row: **O(N×M)**. It is intentionally suitable only for small fixtures and is not production candidate generation.

Identity mappings are equally weighted. Exact normalized equality contributes `1`. Text-only non-equality uses Python's transparent `SequenceMatcher` ratio when that ratio is at least `0.65`; lower text similarity and non-text disagreement contribute `0`. Missing one or both values contributes `0`. The displayed baseline score is the arithmetic mean across identity mappings. Comparison/survivorship mappings never enter this calculation.

Decision bands are deterministic temporary configuration:

- **Proposed match:** top score `>= 0.82`, runner-up margin `>= 0.08`, and no other A row prefers the same B row.
- **Needs review:** top score `>= 0.38` but the proposed-match rule is not satisfied.
- **Only A:** top score `< 0.38` (or no B rows exist).
- Up to three alternatives at score `>= max(0.30, top score - 0.25)` are retained.
- **Only B:** B rows absent from all retained candidate alternatives.

Scores are not calibrated probabilities. No precision, recall, benchmark-quality, or production-readiness claim is made.

## Verify

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @samewise/web build
pnpm verify
```

Run the matcher boundary directly:

```text
uv run --project services/matcher samewise-matcher health
```

## Current limitations

- CSV only; no XLSX.
- Process-local product state; no durable run or decision persistence.
- Local immutable artifacts; no object storage.
- Naive O(N×M) candidate comparison; no blocking, indexing, assignment, or scalable candidate generation.
- Baseline scores are uncalibrated.
- Manual mapping only; no semantic AI mapping.
- No authentication, database, queue, worker, or production observability platform.

## Repository map

- `apps/web`: guided React workflow
- `apps/api`: Fastify orchestration, process-local state, immutable artifact handling, and export
- `services/matcher`: Python profiling, normalization, baseline comparison, and fixture tooling
- `packages/contracts`: canonical JSON Schema plus TypeScript runtime validation
- `fixtures`: visible synthetic inputs and separately stored evaluation-only truth
- `evaluation`: benchmark manifests and factual fixture reports; no matcher metrics are claimed
- `docs`: product, architecture, and decisions
