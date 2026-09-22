# Product

## Purpose and fit

Samewise helps a person reconcile two overlapping CSV datasets when entity identity is uncertain and value conflicts need an auditable later decision. Its useful niche is a one-time migration or consolidation with ambiguous matches. Clean keys may be better handled by SQL or Power Query; recurring governance, durable entity stores, and enterprise connectors call for a fuller MDM or commercial platform. [SW-013](../evaluation/competitors/sw-013/summary.md) documents the competitive boundary.

## The five user jobs

1. **Upload.** Add two CSV files. Samewise profiles them and keeps the original bytes immutable.
2. **Match setup.** Confirm corresponding fields and their semantic families. A field's `useForMatching` flag controls identity evidence independently from `includeInMerge`, which controls later value comparison. Optional metadata-only AI suggestions are advisory and validated; manual setup always works.
3. **Review matches.** The matcher automatically links only cases passing its explicit evidence rules, leaves weak cases unmatched, and sends uncertainty to human review. Review shows actual field-level agreement and contradiction, alternatives, rank and collision context. Repeated evidence patterns can be previewed in deterministic groups; only eligible cases can receive a human-confirmed batch decision. Individual Same/Different, defer/restore, and guarded undo remain available.
4. **Merge values.** Only effective identity links can create value conflicts. Configure field-level closed rules, inspect a read-only impact preview, and explicitly apply the merge plan. Manual resolutions are retained until changed or cleared. Remaining exceptions can be handled individually. Keep Both preserves both source values without asserting a false canonical winner.
5. **Export.** The reconciliation report and manifest can expose pending work. Trusted merged output is available only after unresolved identity and required value conflicts are cleared. The manifest binds current decisions and source fingerprints to exact CSV hashes; an ordinary run retains its matcher-produced semantic evidence plan and candidate configuration.

The user-facing distinction is simple: **“Are these the same entity?” is one decision; “which value should be kept?” is another.** An automatic match never silently chooses a source value.

## Trust model

Algorithms generate candidates and score field evidence. AI only helps interpret schema metadata; it does not see wholesale source rows or decide row identity. Human confirmation is required for mappings and uncertain identity. Match scores are not probabilities. The system can abstain when evidence is weak, and the low-information synthetic gate specifically exercises that behavior. Provenance records what happened, not whether the source's business value was objectively true.

Evaluation uses versioned, truth-blind synthetic fixtures and explicit denominators. Hidden truth is read only after matching; human decisions collected from the ambiguity-enriched review queue are a separate, nonrepresentative evidence type. See [review generalization](review-generalization-report.md), [evaluation](sw-009-evaluation.md), and [export provenance](sw-010-export-provenance.md).

## Non-goals and current limits

Samewise is not a general spreadsheet join, autonomous AI record matcher, durable master-data platform, or global assignment engine. It is CSV-focused and stores live run state in one API process. A restart discards active decisions; the public demo is a constrained deployment, not an enterprise service. Synthetic success does not establish real-upload accuracy.
