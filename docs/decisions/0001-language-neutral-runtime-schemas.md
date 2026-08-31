# ADR 0001: Use language-neutral runtime schemas at process boundaries

- Status: Accepted
- Date: 2026-08-30

## Context

Samewise has TypeScript product applications and a Python matcher. Compile-time TypeScript types disappear at runtime and cannot validate Python messages. Python type annotations likewise do not define the contract seen by TypeScript. Process boundaries need a representation both ecosystems can inspect and test.

## Decision

Use versioned JSON Schema documents in `packages/contracts/schemas` as the canonical interchange representation. TypeScript consumers validate with Zod. Python consumers validate with Pydantic. The initial `HealthResponse` contract is version `1.0.0`.

For now, synchronization is verified by focused tests in each language using a shared set of valid and invalid JSON examples. Any contract change must update the canonical schema, both runtime representations, compatibility examples, and their tests in the same change. Automatic schema generation is deferred until repeated contracts demonstrate that it would reduce more risk than it adds.

## Consequences

- Runtime validation is required on both sides of a process boundary.
- Contract versions and schemas are reviewable without executing either language.
- Some definitions are intentionally duplicated between JSON Schema, Zod, and Pydantic.
- Tests must detect drift, and contributors must update all representations together.
- The repository avoids a premature code-generation toolchain.

## Alternatives considered

### TypeScript types as the source of truth

Rejected because they do not provide Python runtime validation and are erased during compilation.

### Pydantic models as the source of truth

Rejected because this would invert the same problem for TypeScript and couple product applications to matcher tooling.

### Generate all language bindings immediately

Deferred because one small contract does not justify generator selection, generated-code policy, or added build complexity.

### Unstructured JSON documented in prose

Rejected because prose cannot enforce literal values, required fields, or rejection of unexpected data.
