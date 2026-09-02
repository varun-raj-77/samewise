# ADR 0002: Use OpenAI only through a server-side structured semantic-mapping boundary

- Status: Accepted
- Date: 2026-08-31

## Context

Manual column mapping is reliable but slow when two sources use different schema language. A model can assist with the semantic question of what columns appear to mean, but record identity, survivorship, and matcher evidence must remain deterministic product concerns. Uploaded datasets may contain sensitive source values, and model output is untrusted.

## Decision

The Fastify API may call OpenAI only to propose semantic column mappings. The browser never receives a provider key and the Python matcher never calls OpenAI. The default `metadata-first-v1` request contains column name, inferred type, null rate, and distinct rate. It excludes filenames, hashes, filesystem paths, sample values, rows, row identifiers, and all fixture truth/provenance.

OpenAI Structured Outputs constrain the response to the versioned semantic-mapping schema. Samewise then performs its own domain validation against authoritative server-owned profiles. A validated proposal stores provider, model identifier, response identifier, prompt version, schema version, request-policy version, original suggestions, and human decisions. Pending proposals never become matcher mappings. Accept, reject, and remap are explicit; an edit retains the original proposal and stores a separate final mapping.

Normalization hints use an allowlist and remain advisory. Samewise never executes model-generated transformations or code. Provider absence, timeouts, errors, invalid output, and empty output leave existing confirmed mappings unchanged and preserve manual mapping as the working path.

## Consequences

- OpenAI reduces schema-mapping effort but is not required for reconciliation correctness.
- Model responses are not reproducible historical facts unless the validated proposal and response provenance are retained.
- Schema-mapping evaluation is separate from row-matching evaluation; hidden truth can be joined only after proposal generation in tests or evaluation code.
- The integration adds the official `openai` Node SDK but no provider framework, agent framework, vector store, queue, or matcher dependency.
