# Samewise

Samewise takes two messy CSV datasets, determines which records refer to the same real-world entity, asks a human about uncertain candidates, and produces an explicit reconciliation export.

SW-008 adds deterministic, provenance-retaining field survivorship and a gated
trusted merged output on top of the frozen SW-006 matcher and SW-007 review workspace:

1. Upload immutable Dataset A and Dataset B CSV files.
2. Inspect Python-generated profiles and limited representative samples.
3. Request metadata-only AI column suggestions or map manually; accept, reject, or remap every suggestion before it can become active.
4. Generate candidates from confirmed identity mappings, then run
   `feature-pipeline-v0.1.0` and `explainable-matcher-v0.2.0` only on those pairs.
5. Work a virtualized per-A Needs Review queue with real progress, filters,
   deterministic evidence labels, aligned raw values, ranked alternatives, and
   explicit collision context.
6. Record **Same entity**, **Different entity**, or **Defer** with mouse or keyboard;
   decisions auto-advance and an eligible recent decision can be undone safely.
7. Only after identity confirmation, manually choose **Use A**, **Use B**, or
   **Keep both**, or configure a safe per-field rule.
8. Preview a versioned rule before explicitly applying it; unresolvable cases and
   existing manual choices remain untouched.
9. Export a formula-safe reconciliation report at any time. Export trusted merged
   output only when identity and relevant field conflicts are fully resolved.

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
| `PATCH` | `/api/runs/:runId/review-items/:aRowId` | Defer or return one unresolved A-side review item |
| `POST` | `/api/runs/:runId/review-undo` | Undo the most recent eligible human identity decision |
| `POST` | `/api/runs/:runId/conflicts/:conflictId/resolutions` | Record or explicitly replace Use A/Use B/Keep Both |
| `DELETE` | `/api/runs/:runId/conflicts/:conflictId/resolution` | Clear current resolution and retain history |
| `PUT` | `/api/runs/:runId/survivorship-policy` | Configure a validated versioned policy without applying it |
| `POST` | `/api/runs/:runId/survivorship-preview` | Preview one configured field rule and bulk counts |
| `POST` | `/api/runs/:runId/survivorship-apply` | Explicitly apply a rule without overwriting manual resolutions |
| `GET` | `/api/runs/:runId/export` | Download the always-available reconciliation report |
| `GET` | `/api/runs/:runId/trusted-export` | Download trusted merged output only when readiness passes |

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
uv sync --project services/matcher --locked
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @samewise/web build
pnpm verify
```

`uv` remains the Python dependency manager. Root verification prefers `uv` when
it is available on `PATH`; after the normal sync above it can also use the
project-local `services/matcher/.venv` directly on Windows or POSIX. If neither
is available, verification stops with the required setup command instead of
creating a temporary command shim.

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
- Refresh and route navigation recover `?run=<run-id>&screen=<stage>` only while
  that API process is still alive.
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
- Survivorship policy, current resolutions, and compact history are process-local.
- Prefer newest accepts explicit mapped ISO date/timestamp strings; it never infers
  business time from upload time or arbitrary locale date text.
- Multiple effective links are exported separately rather than collapsed into a
  multi-record golden entity.

## Survivorship semantics

Identity and survivorship are separate. SAME alone creates no selected value.
Supported field strategies are Use A, Use B, Keep Both, Prefer non-null, Prefer
newest, and Prefer trusted source. Missing for non-null rules means only an empty or
whitespace-only parsed string; literals such as `NULL` and `N/A` remain source data.
Trusted-source rules are per mapped comparison field and have no implicit fallback.
Newest requires an explicit mapped date field and leaves missing, malformed, or tied
timestamps unresolved.

KEEP BOTH is not a delimiter-concatenated canonical value. Trusted CSV leaves the
canonical field empty and emits dedicated `<field>__A`, `<field>__B`, and resolution
metadata columns. See [docs/sw-008-survivorship.md](docs/sw-008-survivorship.md).

Synthetic tests establish deterministic rule correctness. They are not a claim of
real-world survivorship accuracy.

## Repository map

- `apps/web`: guided React workflow
- `apps/api`: Fastify orchestration, process-local state, immutable artifact handling, and export
- `services/matcher`: Python profiling, candidate generation/evaluation, baseline comparison, and fixture tooling
- `packages/contracts`: canonical JSON Schema plus TypeScript runtime validation
- `fixtures`: visible synthetic inputs and separately stored evaluation-only truth
- `evaluation`: versioned fixture/candidate configs, deterministic snapshots, and factual candidate-recall reports
- `docs`: product, architecture, and decisions
