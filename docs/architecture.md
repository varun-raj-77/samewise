# Architecture

Samewise begins with three executable surfaces and one shared contract package. The split protects process boundaries without committing to infrastructure that has not been justified by measurements.

## Responsibilities

### `apps/web`

The React/Vite application owns a seven-step upload-to-export workflow. It validates API run views at runtime and depends on the shared contract package rather than API implementation details. Identity review and field resolution are separate screens and actions.

### `apps/api`

The Fastify application orchestrates product workflows, owns process-local run metadata, records identity decisions and field resolutions, and creates reconciliation exports. Server construction remains separate from process startup so tests use Fastify injection without binding a TCP port.

Uploaded source bytes are saved once under generated names in ignored `.samewise-data/<run-id>/` directories and fingerprinted with SHA-256. Original filenames are metadata only and never become filesystem paths. Source bytes are not rewritten by mapping, matching, review, resolution, or export. This is local development artifact handling, not an object-storage design.

### `services/matcher`

The Python package owns CSV profiling, explicit baseline normalization, all-pairs comparison, inspectable evidence, and deterministic score/band generation. It also retains the machine-readable health command and deterministic fixture tooling. It does not run an HTTP server.

Node invokes `samewise-matcher process` as a short-lived subprocess and sends one versioned JSON request over stdin. Python validates the request with Pydantic and emits one validated JSON profile or matcher result over stdout. Filesystem paths cross only this internal Node/Python boundary and are not returned to the browser.

### Fixture and evaluation boundary

Organization fixture generation lives in the Python package, not in the API or web application. A seed and validated configuration produce immutable canonical entities, independently corrupted source views, and stable artifact ordering without wall-clock input.

Visible matcher inputs are CSV files beneath `fixtures/corrupted`. They contain independent A/B source row identifiers and differing source schemas. Hidden artifacts beneath `fixtures/canonical`, `fixtures/ground-truth`, and `fixtures/adversarial` contain canonical IDs, identity mappings, corruption provenance, schema truth, and hard-negative definitions. Product matching code must consume only the visible inputs; evaluation code may join hidden truth after matching. Versioned manifests and factual summaries live under `evaluation`.

Corruption is explicit and replayable across name, phone, email, address, postal, business-value, and timestamp categories. Hard negatives are designed as different canonical entities with similar evidence. Duplicate rows map many source row IDs to one canonical ID, so the truth format does not impose a one-to-one relationship.

### `packages/contracts`

This package owns canonical, versioned JSON Schemas for process-boundary messages. It also exposes Zod validators for TypeScript consumers. Python maintains an equivalent Pydantic model rather than pretending TypeScript types are Python runtime contracts.

Schema synchronization is intentionally manual for now: contract tests assert the canonical schema's constraints, and shared valid and invalid JSON examples must receive the same result from the schema expectations, Zod, and Pydantic. A contract change must update the JSON Schema, both runtime representations, shared compatibility examples, and tests together. Code generation can be reconsidered when contract volume makes this process unreliable.

## Dependency and process boundaries

```text
Browser (apps/web) --validated HTTP--> Node API (apps/api)
          |                              |
          +---- packages/contracts <-----+

Node orchestration --validated JSON/stdin subprocess--> Python matcher
                                                        |
                                              canonical JSON Schema
```

The web app depends on the TypeScript contract package, not on API source. The API also depends on that package. The matcher has its own Pydantic representation and verifies applicable messages against the same language-neutral schema. The subprocess boundary is deliberately synchronous and small-fixture-only; no Python HTTP service, queue, or worker has been introduced.

## Why matching is separate from Node orchestration

Python has a mature ecosystem for data processing, statistical evaluation, and matching research. Keeping matcher behavior in a dedicated Python package allows it to evolve and be evaluated independently while Node remains responsible for HTTP and product orchestration. The boundary also forces inputs and outputs to be explicit, versioned, and runtime-validated.

## SW-003 development persistence

Run metadata, mappings, matcher results, decisions, conflicts, and resolutions are held in API process memory. Immutable upload bytes live in the ignored local artifact directory so Python can read them. IDs and boundary concepts are stable enough to move behind persistent repositories later, but no database abstraction or fake enterprise persistence is present. The persistence approach for large results remains deliberately undecided until measurements justify it.

## Identity and resolution state

`IdentityDecision` captures the candidate, system proposal, human decision, matcher version, evidence shown, and timestamp. A same-entity decision may create `FieldConflict` records for comparison mappings; it cannot create a `FieldResolution`. Resolution is a later endpoint call that records Use A/Use B, the chosen source/value, and its own timestamp. Export consumes both states and emits unresolved conflicts without a trusted value.
