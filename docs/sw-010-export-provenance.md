# SW-010 export and provenance

## Existing-export audit

SW-003 already produced one formula-safe reconciliation CSV with matched links,
pending review, A-only/B-only rows, source hashes, matcher/candidate/mapping versions,
raw mapped values, and field-resolution state. SW-008 added a separate trusted CSV,
readiness blockers, source-only provenance, equal-field handling, deterministic
policy results, and explicit KEEP BOTH columns. Source files were never rewritten.

The audit found three gaps: rejected candidates and deferred review were not explicit
in reconciliation rows, artifact versions were informal `v1`/`v2` strings, and no
portable manifest bound provenance to exact artifact bytes. The trusted readiness
logic itself required no replacement.

## Artifacts

- `reconciliation-export-v3.0.0`: always available after matching. It includes
  system-established links, human SAME and DIFFERENT decisions, pending/deferred
  identity, A-only/B-only state, scores/collision state, conflict and resolution
  identifiers, manual/rule origin, raw mapped values, and source fingerprints.
- `trusted-merged-export-v2.0.0`: available only when identity review has no pending
  or deferred items and every visible comparison conflict is resolved. Equal values
  flow naturally. USE A/USE B and closed deterministic rules emit their actual
  selected values and provenance.
- `run-manifest-v1.0.0`: records the snapshot descriptor, datasets, confirmed
  mappings and AI/human mapping provenance when present, candidate/matcher versions,
  identity and survivorship summaries, and filenames/SHA-256/byte lengths for the
  CSV artifacts.

The manifest schema is in
`packages/contracts/schemas/run-manifest/1.0.0.json`. Ordinary product runs now
retain the matcher-produced bounded evidence plan. The run view passes the plan
through to the manifest without recomputing it; the SHA-256 covers its canonical
JSON serialization. The plan contains the candidate strategy/configuration,
mapping IDs, semantic families, comparators, and bounded classifications. Confirmed
mapping details and matcher configuration are adjacent manifest fields. Legacy or
test runs with no retained plan report `not_retained` and export `{}` truthfully;
older manifests remain readable. No evaluation snapshot is attached to an ordinary
run.

## Traceability and truthfulness

A resolved trusted value can be traced through resolution ID, manual or
deterministic-rule origin, rule/policy ID, A/B values, identity decision ID/source,
matcher/candidate versions, and immutable source fingerprints. KEEP BOTH emits an
empty canonical field with the two source values and explicit resolution metadata.
Source-only records retain `source_only_a` or `source_only_b` provenance.

Survivorship records why a value was selected; it does not claim the value is
objectively correct. System identity links remain distinguishable from human SAME.
Human DIFFERENT rows retain their original system proposal evidence in process
state and decision identifiers in the report.

`configuredFieldPolicies` means the policy currently configured for the run. It
does not rewrite existing field resolutions. Each applied resolution retains the
strategy, rule ID, policy version, origin, and reason that produced it. Human
identity decision counts are pair-level decisions, including each batch-applied
pair once; batch provenance is a subset, not an additional count. Manual value
decisions are reported separately from deterministic rule outcomes.

## Determinism, CSV, and security

For unchanged run state, exports use fixed headers, stable row ordering, CRLF line
endings, UTF-8, and no wall-clock export timestamp. The manifest hashes exact CSV
bytes and intentionally does not hash itself. Empty or absent source values become
empty cells. Commas, quotes, multiline values, and Unicode follow RFC-style CSV
escaping. Formula-leading text is prefixed with an apostrophe on every CSV surface;
plain negative numeric strings are preserved.

Generated filenames use only the server-generated run ID. Original upload names are
basename metadata and never filesystem paths. Manifests exclude raw datasets,
secrets, environment variables, server paths, complete prompt payloads, hidden
canonical IDs, corruption provenance, and benchmark truth.

## Limitations

Artifacts and workflow state remain process-local and are regenerated on demand.
There is no durable freeze, database, object storage, signature, bundle/ZIP, worker,
or streaming layer. The current in-memory approach is adequate for the measured
development fixture and the 10,000-row export sanity test; scale work should be
driven by later measurement.
