# Review generalization implementation plan

Status: implementation plan recorded before production matcher changes.

## Audit findings

- The guided product model is already Upload → Match setup → Review matches →
  Merge values → Export and must remain unchanged.
- `confirmed-mappings-v2` separates `useForMatching` from `includeInMerge`, but
  does not persist a confirmed semantic family. Node adapts matching fields back
  to the matcher's legacy `identity` role.
- Semantic mapping is strict, metadata-only structured output. It can distinguish
  source-specific columns, but cannot return a semantic family.
- Profiles contain row count, null count/rate, distinct count/rate, inferred type,
  and three samples. They do not retain normalized distinctiveness, common-value
  frequency, pattern shape, or cross-source exact overlap.
- Candidate engine v0.3 and feature pipeline v0.1 infer field kinds from mapping
  IDs, labels, and column names. Generic fields get exact candidate keys, but the
  scorer treats them as fuzzy text. Any field containing “name” is treated as the
  entity name, including contact-person fields.
- Candidate generation is an indexed union of conservative routes with bounded
  bucket suppression and recorded blocker/key-hash provenance. It is not
  quadratic. Collision routing, minimum two-field auto agreement, fixed
  thresholds, and alternative retention are already deterministic.
- Strong contradiction currently means a phone, email, or domain conflict only.
  Persistent-identifier conflict is not representable.
- Review is bounded by page and candidate-detail projections, with individual
  SAME/DIFFERENT, defer/restore, a short undo stack, alternatives, and dependency
  guards. It has no workload summary, stable generic group signature, bounded
  group preview, batch decision origin, or batch undo unit.
- SW-005/SW-005F candidate snapshots, the SW-006 frozen matcher, SW-009 immutable
  evaluation snapshots, and SW-012 bounded projections are historical baselines
  and will not be rewritten.

## Phased plan

1. Add a truth-separated deterministic public-style 8K workload generator and a
   review-forensics harness. Reproduce the reported workload closely enough to
   identify review composition before changing matcher semantics. Commit only
   compact analysis and summary artifacts, never the generated CSVs.
2. Add a small confirmed semantic-family model and deterministic evidence plan.
   Persistent identifiers compare exactly; source-local identifiers are excluded
   from identity evidence by default; contact-person evidence is distinct from
   entity name; unknown/free-text evidence is conservative. Derive bounded
   distinctiveness summaries locally and use them to prevent repeated supporting
   values from independently manufacturing review-worthy evidence. Keep decision
   thresholds unchanged.
3. Validate the semantic change against the frozen holdout, weak-ID and hard
   negatives, candidate benchmarks, and deterministic multi-domain fixtures.
   Candidate-recall regression is a blocker. Low-information data must abstain.
4. Add versioned dataset-agnostic review signatures, authoritative group summary,
   bounded paged preview, conservative per-action eligibility, explicit human
   batch apply, per-pair provenance, and guarded batch undo. Preserve individual
   decisions, defer/restore, alternatives, and export gates.
5. Change the large-queue review entry to grouped workload categories while
   preserving the detailed side-by-side workspace as the individual-review view.
6. Run the full repository verification plus the new analysis, generalization,
   grouping, batch, payload, provenance, and performance checks. Record measured
   before/after results without replacing historical artifacts.

## Versioned artifacts that may be affected

- Confirmed mapping contract/version and semantic-mapping structured output and
  prompt (only if semantic family crosses those boundaries).
- Evidence-plan version and its bounded run provenance.
- Candidate engine/config version (only if candidate routes change).
- Feature pipeline, matcher, and matcher-config versions (if comparison/scoring
  semantics change; decision thresholds are expected to remain identical).
- Workflow runtime schema representations where new evidence or projections cross
  Node/Python/browser boundaries. The repository's pre-release workflow schema
  path remains synchronized rather than mechanically renamed.
- Review-signature version and identity-decision provenance version.
- Run-manifest provenance fields for confirmed semantics, evidence plan, review
  signatures, and human batch origins.

Historical benchmark and evaluation artifacts remain immutable. New measurements
will be written to new review-workload/generalization report locations.
