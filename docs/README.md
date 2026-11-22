# Documentation guide

## Start here

- [Product](product.md): user workflow, trust model, and fit.
- [Architecture](architecture.md): boundaries, run lifecycle, and current versions.
- [API](api.md): current route inventory and behavior.
- [Deployment](deployment.md): constrained public demo topology.
- [Demo storyboard](demo.md): a one-minute product walkthrough.
- [SW-046 review input safety](sw-046-review-input-safety.md): global shortcut ownership and stable review context during pending decisions.
- [SW-047 results evidence context](sw-047-results-evidence-context.md): reject mismatched result projections and keep displayed evidence scoped to its run and row.
- [SW-048 merge-plan preview safety](sw-048-survivorship-preview-safety.md): keep displayed previews and Apply responses bound to the current run and draft rules.
- [SW-049 conflict evidence scope](sw-049-conflict-evidence-scope.md): reject foreign conflict pages and hide stale field-resolution controls across run changes.
- [SW-052 address-rescue benchmark](sw-052-address-location-probe.md): reproducible 1K/10K candidate-recall and false-candidate experiment, intentionally not enabled in the product.
- [Social preview](assets/social-preview.png): GitHub-ready image; [editable SVG source](assets/social-preview.svg). Render with `node scripts/render-social-preview.mjs` after setting `SAMEWISE_RUNTIME_NODE_MODULES` to the existing Playwright module directory.

## Design decisions

- [ADR 0012](decisions/0012-dataset-adaptive-semantic-evidence-and-review-groups.md): current semantic evidence plan and safe review groups.
- [ADR 0010](decisions/0010-bounded-api-projections-retain-authoritative-evidence.md): browser projection boundary.
- [ADR 0009](decisions/0009-deterministic-export-snapshots-and-hashed-run-manifests.md): export snapshots.
- [ADR 0007](decisions/0007-versioned-deterministic-survivorship-and-trusted-export-gate.md): separate value choice and readiness.

## Evaluation and historical evidence

- [Review generalization closeout](review-generalization-report.md) and [its reports](../evaluation/reports/review-generalization/): current v0.3 matcher / v0.4 candidate results across the public-style workload, holdout, weak-ID, and domain gates.
- [SW-009 evaluation](sw-009-evaluation.md): metric definitions, compatible comparison, and snapshot rules. Its frozen SW-006 reproduction is historical.
- [SW-010 export provenance](sw-010-export-provenance.md): current manifest behavior and deterministic CSV artifacts.
- [SW-011 performance](sw-011-performance.md): measured stage and candidate-only 50K evidence under its documented configuration.
- [SW-012 bounded evidence](sw-012-bounded-evidence.md): measured browser payloads and explicit memory boundary.
- [SW-013 adversarial validation](../evaluation/competitors/sw-013/summary.md): competitor fit and claim boundaries; only Samewise scenarios were executed.
- [Earlier milestone reports](../evaluation/reports/): retained evidence for the versions and fixtures they actually measured. They should not be read as current product defaults.

The [guided redesign note](guided-reconciliation-redesign.md), [result-state consistency audit](result-state-consistency-audit.md), and older ADRs document decisions at their respective times. The product and architecture guides above describe the current application.
