# Samewise

Samewise takes two messy CSV datasets, determines which records refer to the same real-world entity, asks a human about uncertain candidates, and produces an explicit reconciliation export.

SW-006 combines the measured, truth-blind candidate engine with the first
versioned, explainable multi-field matcher while preserving the SW-003 scorer and
all-pairs path for comparison:

1. Upload immutable Dataset A and Dataset B CSV files.
2. Inspect Python-generated profiles and limited representative samples.
3. Request metadata-only AI column suggestions or map manually; accept, reject, or remap every suggestion before it can become active.
4. Generate candidates from confirmed identity mappings, then run
   `feature-pipeline-v0.1.0` and `explainable-matcher-v0.2.0` only on those pairs.
5. Inspect Auto Match, Needs Review, Only A, and Only B results, ranked alternatives,
   blocker provenance, normalized values, features, agreements, conflicts, and
   missing evidence.
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

AI mapping is optional. Set `OPENAI_API_KEY` only in the API server environment and optionally set `OPENAI_MODEL` (development default: `gpt-5-mini`). Never use a `VITE_` variable for the key. Without a key—or after a provider, timeout, or validation failure—the mapping screen remains fully usable manually.

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
| `POST` | `/api/runs/:runId/mapping-suggestions` | Generate a validated metadata-only proposal from server-owned profiles |
| `PATCH` | `/api/runs/:runId/mapping-suggestions/:suggestionId` | Accept, reject, or remap one proposal without overwriting its origin |
| `POST` | `/api/runs/:runId/match` | Invoke candidate generation and the explainable matcher |
| `POST` | `/api/runs/:runId/candidates/:candidateId/decisions` | Record Same/Different identity |
| `POST` | `/api/runs/:runId/conflicts/:conflictId/resolutions` | Record Use A/Use B resolution |
| `GET` | `/api/runs/:runId/export` | Download reconciliation CSV |

Uploads use a CSV content type plus an `X-File-Name` header. The development limit is 2 MiB per file.

## Candidate generation and explainable scoring

All-pairs comparison grows as **O(N×M)**: 100,000 rows on each side imply 10
billion comparisons. Product matching now uses `candidate-engine-v0.2.0`, which
builds hash/inverted indices and unions five independent passes: exact normalized
phone/email/domain, meaningful name token, name character prefix, location plus
name, and address number plus name. The v2 contextual passes include conservative
exact compact-name composites that recover spacing/suffix variants without relaxing
bucket limits. Empty keys are never indexed. Whole blocking
buckets above the versioned 20-row-per-side or 100-relationship limits are
suppressed and measured; accepted buckets are never partially truncated.

Generation sees only visible rows, confirmed mappings, and explicit config. Hidden
identity truth and corruption provenance are loaded later by evaluation. The naive
all-pairs path remains an explicit small-test oracle.

The retained falsification report at `evaluation/reports/sw-005f/README.md` records
13,801 candidates from 73,960,000 theoretical pairs on the original 10K fixture
(5,359.031954x reduction), retaining 7,164/7,164 known true pairs. On a separate
1,500-entity weak-identifier fixture, v0.2 retained 1,035/1,043 true pairs with no
surviving exact phone/email/domain. This is
**candidate recall**: a true pair survived blocking. It is not final record-matching
recall, precision, accuracy, or evidence that the scorer made the right decision.
Synthetic domains are unusually strong, and runtime is hardware-dependent.

After candidate generation, only confirmed identity mappings enter the explicit
feature pipeline. Name, phone, email, domain, address, city, region, postal, and
generic text evidence have versioned Samewise-owned feature definitions. Each field
stores its normalized values, bounded feature values, evidence class, configured
weight, positive contribution, conflict contribution, and deterministic explanation
code. Comparison/survivorship mappings never enter identity scoring.

The bounded match score is
`max(0, weighted positive evidence - weighted conflict evidence) / total configured identity weight`.
Missing values contribute zero and do not shrink the denominator. Strong non-empty
phone, email, or domain contradictions prevent auto-match but do not act as
authoritative identity truth.

Frozen `matcher-config-v0.2.0` decision bands are:

- **Auto match:** top score `>= 0.50`, margin `>= 0.04`, at least two agreeing fields,
  no strong contradiction, and no preferred-B collision.
- **Needs review:** top score `>= 0.25` without satisfying every auto-match rule.
- **Unmatched / Only A:** top score `< 0.25` or no candidate.
- Up to three alternatives at score `>= max(0.25, top score - 0.30)` are retained.

On the untouched 1,200-entity synthetic holdout, candidate-engine-v0.2.0 retained
866/879 true links. The matcher auto-matched 253/253 correctly, routed 598/858
matchable A rows to review, ranked a true candidate first for 839/846 eligible rows,
and auto-matched none of six hard-negative candidate pairs. These are fixture facts,
not calibrated probabilities or evidence of real-data quality. The full denominator
definitions and failure decomposition are in `evaluation/reports/sw-006/README.md`.

## Verify

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @samewise/web build
pnpm verify
```

Normal tests mock the OpenAI boundary and require no network or API key. To run one opt-in live development evaluation against only the visible organization fixtures:

```powershell
$env:SAMEWISE_LIVE_OPENAI='1'
$env:OPENAI_API_KEY='your-uncommitted-key'
pnpm --filter @samewise/api test -- live-semantic-mapping
```

The live call is generated from visible profiles first. Only afterward does evaluation code compare proposed pairs with hidden schema truth and report exact correct, incorrect, missed expected, and extra proposed counts. Precision is exact-correct divided by all proposed pairs; recall is exact-correct divided by all expected pairs. No live accuracy result is claimed unless that command actually runs.

Run the matcher boundary directly:

```text
uv run --project services/matcher samewise-matcher health
```

Generate a configured fixture and benchmark candidate retention:

```text
uv run --project services/matcher samewise-matcher fixtures generate-config --config evaluation/benchmark-configs/organizations-candidates-1k.json --output-root .samewise-data/generated-1k
uv run --project services/matcher samewise-matcher candidates benchmark --root .samewise-data/generated-1k --fixture organizations-candidates-1k-v1 --mappings evaluation/configs/organizations-confirmed-mappings-v1.json --config evaluation/configs/candidate-engine-v0.2.0.json --output-dir .samewise-data/benchmarks/organizations-candidates-1k-v1
```

## Current limitations

- CSV only; no XLSX.
- Process-local product state; no durable run or decision persistence.
- Local immutable artifacts; no object storage.
- Synthetic candidate quality is not evidence of real-data recall; 100K-row
  behavior remains unmeasured.
- The baseline scorer still ranks candidates in process memory and is not the
  default product matcher; it remains runnable only for comparison.
- Match scores are uncalibrated evidence scores.
- Synthetic tune/holdout results do not establish real-data quality or threshold
  transferability.
- AI schema mapping is process-local, requires human review, and is not a substitute for deterministic row matching.
- No authentication, database, queue, worker, or production observability platform.

## Repository map

- `apps/web`: guided React workflow
- `apps/api`: Fastify orchestration, process-local state, immutable artifact handling, and export
- `services/matcher`: Python profiling, candidate generation/evaluation, baseline comparison, and fixture tooling
- `packages/contracts`: canonical JSON Schema plus TypeScript runtime validation
- `fixtures`: visible synthetic inputs and separately stored evaluation-only truth
- `evaluation`: versioned fixture/candidate configs, deterministic snapshots, and factual candidate-recall reports
- `docs`: product, architecture, and decisions
