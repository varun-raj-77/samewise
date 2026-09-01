# Architecture

Samewise begins with three executable surfaces and one shared contract package. The split protects process boundaries without committing to infrastructure that has not been justified by measurements.

## Responsibilities

### `apps/web`

The React/Vite application owns a seven-step upload-to-export workflow. It validates API run views and semantic-mapping responses at runtime and depends on the shared contract package rather than API implementation details. Mapping suggestions have visible pending, accepted, rejected, or edited state; only confirmed mappings reach matching. Identity review and field resolution remain separate screens and actions.

### `apps/api`

The Fastify application orchestrates product workflows, owns process-local run metadata, records identity decisions and field resolutions, and creates reconciliation exports. Server construction remains separate from process startup so tests use Fastify injection without binding a TCP port.

Fastify is also the sole OpenAI integration boundary. It builds `metadata-first-v1` input from its authoritative profiles using only column name, inferred type, null rate, and distinct rate. It omits samples, filenames, hashes, paths, row data, IDs, canonical entities, schema truth, identity truth, and corruption provenance. The API uses a versioned developer prompt and strict structured output, then independently validates referenced columns, enums, confidence, allowlisted hints, duplicates, and mapping/unmapped consistency. Provider failures do not mutate proposals or confirmed mappings.

Uploaded source bytes are saved once under generated names in ignored `.samewise-data/<run-id>/` directories and fingerprinted with SHA-256. Original filenames are metadata only and never become filesystem paths. Source bytes are not rewritten by mapping, matching, review, resolution, or export. This is local development artifact handling, not an object-storage design.

### `services/matcher`

The Python package owns CSV profiling, truth-blind multi-pass candidate generation,
`feature-pipeline-v0.1.0`, inspectable weighted evidence, and deterministic
`explainable-matcher-v0.2.0` score/band generation. Product requests score generated
candidates only. The old baseline and all-pairs path remain explicit comparison and
small-fixture oracle paths. The package also retains the machine-readable health
command and deterministic fixture tooling. It does not run an HTTP server.

Node invokes `samewise-matcher process` as a short-lived subprocess and sends one versioned JSON request over stdin. Python validates the request with Pydantic and emits one validated JSON profile or matcher result over stdout. Filesystem paths cross only this internal Node/Python boundary and are not returned to the browser.

The candidate engine receives visible records, confirmed `ManualMapping` values,
and versioned candidate config only. It does not receive OpenAI provenance, pending
or rejected suggestions, reasons, confidence, normalization hints, canonical IDs,
identity truth, corruption provenance, schema truth, or hard-negative labels. It
never asks a model whether rows are the same entity.

Candidate generation normalizes conservative blocking evidence, creates independent
inverted indices, unions their cross-source buckets, deduplicates pairs, and keeps
all blocker/key-hash provenance. Oversized keys are suppressed as complete buckets
with measured affected relationship counts. No per-record cap or partial bucket
truncation exists. Evaluation loads truth only after generation and computes
candidate recall, pair reduction, blocker contribution, zero-candidate records,
and missed-pair diagnostics.

Adversarial SW-005F evaluation falsified v0.1 on weak identifiers. Version 0.2
preserves the original passes and adds exact compact normalized-name composites
within location and address-number context. The change was selected from repeated
miss patterns, not individual truth IDs; bucket limits are unchanged. Version 0.1
configuration and reports remain available for direct comparison.

The scorer consumes the same visible rows plus confirmed identity mappings. It emits
field-kind-specific normalized features, explicit agreement/conflict/missing classes,
weights, positive and conflict contributions, and deterministic explanation codes.
Its denominator is the total configured identity weight, so missing values cannot
increase a score by removing weight. Strong phone/email/domain contradictions and
preferred-B collisions route candidates away from auto-match. Comparison mappings,
AI proposal confidence, hidden truth, corruption provenance, and survivorship state
are excluded from feature computation.

### Fixture and evaluation boundary

Organization fixture generation lives in the Python package, not in the API or web application. A seed and validated configuration produce immutable canonical entities, independently corrupted source views, and stable artifact ordering without wall-clock input.

Visible matcher inputs are CSV files beneath `fixtures/corrupted`. They contain independent A/B source row identifiers and differing source schemas. Hidden artifacts beneath `fixtures/canonical`, `fixtures/ground-truth`, and `fixtures/adversarial` contain canonical IDs, identity mappings, corruption provenance, schema truth, and hard-negative definitions. Product matching code must consume only the visible inputs; evaluation code may join hidden truth after matching. Versioned manifests and factual summaries live under `evaluation`.

Corruption is explicit and replayable across name, phone, email, address, postal, business-value, and timestamp categories. Hard negatives are designed as different canonical entities with similar evidence. Duplicate rows map many source row IDs to one canonical ID, so the truth format does not impose a one-to-one relationship.

Matcher evaluation generates candidates and scores from visible data before loading
truth. A fixed tuning seed selects thresholds; a separately seeded holdout can run
only with a frozen config naming a different tuning fixture. The report reconciles
candidate misses, below-review-threshold true links, post-score alternative losses,
and the candidate-recall ceiling, and compares the legacy baseline on the identical
candidate set.

### `packages/contracts`

This package owns canonical, versioned JSON Schemas for process-boundary messages. It also exposes Zod validators for TypeScript consumers. Python maintains an equivalent Pydantic model rather than pretending TypeScript types are Python runtime contracts.

Schema synchronization is intentionally manual for now: contract tests assert the canonical schema's constraints, and shared valid and invalid JSON examples must receive the same result from the schema expectations, Zod, and Pydantic. A contract change must update the JSON Schema, both runtime representations, shared compatibility examples, and tests together. Code generation can be reconsidered when contract volume makes this process unreliable.

The workflow contract is currently an internal, pre-release boundary: the package
is private at version `0.0.0`, no external compatibility promise exists, and the
repository's versioning rule requires synchronized representations rather than a
new schema path for every internal iteration. SW-006 updated the canonical schema,
Zod, Pydantic, examples/fixtures, and tests together. The current `workflow/1.0.0`
path is therefore intentionally retained until an external compatibility policy is
adopted; it must not be described as a stable public API.

## Dependency and process boundaries

```text
Browser (apps/web) --validated HTTP--> Node API (apps/api)
          |                              |
          +---- packages/contracts <-----+

Browser --request suggestions--> Fastify --metadata-only structured request--> OpenAI
Browser <--validated proposal---- Fastify <--strict structured output----------+
Human accept/remap --> confirmed ManualMapping --> Python matcher

Node orchestration --validated JSON/stdin subprocess--> Python matcher
                                                        |
                                              canonical JSON Schema
```

The web app depends on the TypeScript contract package, not on API source. The API
also depends on that package. The matcher has its own Pydantic representation and
verifies applicable messages against the same language-neutral schema. The
subprocess boundary remains deliberately synchronous; no Python HTTP service,
queue, or worker has been introduced. The 10K benchmark measures the candidate
engine only, not product result storage or browser rendering.

## Why matching is separate from Node orchestration

Python has a mature ecosystem for data processing, statistical evaluation, and matching research. Keeping matcher behavior in a dedicated Python package allows it to evolve and be evaluated independently while Node remains responsible for HTTP and product orchestration. The boundary also forces inputs and outputs to be explicit, versioned, and runtime-validated.

## SW-003 development persistence

Run metadata, mappings, matcher results, decisions, conflicts, and resolutions are held in API process memory. Immutable upload bytes live in the ignored local artifact directory so Python can read them. IDs and boundary concepts are stable enough to move behind persistent repositories later, but no database abstraction or fake enterprise persistence is present. The persistence approach for large results remains deliberately undecided until measurements justify it.

SW-004 semantic proposals and their provider/model/prompt/schema/request/response provenance are also process-local. The stored validated proposal is the response used for review; Samewise does not claim that a future call can reproduce it. Advisory normalization hints are restricted to a contract allowlist and are never dynamically executed.

## Separate schema-mapping evaluation

Schema-mapping evaluation compares proposed column pairs with hidden SW-002 schema truth only after proposal generation. Exact correct, incorrect, missed expected, and extra proposed counts are independent from row-matcher evidence. Precision uses all proposed pairs as its denominator; recall uses all expected truth pairs. Normal CI uses mocked proposals. A live call is opt-in and never receives hidden truth.

## Identity and resolution state

`IdentityDecision` captures the candidate, system proposal, human decision, matcher version, evidence shown, and timestamp. A same-entity decision may create `FieldConflict` records for comparison mappings; it cannot create a `FieldResolution`. Resolution is a later endpoint call that records Use A/Use B, the chosen source/value, and its own timestamp. Export consumes both states and emits unresolved conflicts without a trusted value.
