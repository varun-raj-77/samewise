# Guided reconciliation redesign

## Decision

Samewise now presents reconciliation as five user jobs: Upload files, Match setup,
Review matches, Merge values, and Export. The implementation changes the product
model and disclosure hierarchy without changing the candidate engine, feature
pipeline, matcher thresholds, contradiction policy, or collision policy.

## Mapping v2

New runs use `confirmed-mappings-v2`. Each mapping records the A/B column
correspondence, label, normalizer, `useForMatching`, and `includeInMerge`. The two
booleans are deliberately independent: a phone can help establish identity and
later be a value conflict. A timestamp can be excluded from merged output while
remaining available to a most-recent rule.

Historical role-based v1 examples and manifest entries are not rewritten. The
shared contract can parse legacy mappings, and an explicit adapter maps v1
`identity`/`comparison` roles into the v2 booleans. At the Python process boundary,
only v2 mappings with `useForMatching: true` are translated into the matcher's
unchanged v1 identity-mapping input. Candidate and matcher versions therefore stay
unchanged.

## Guided surfaces

Match setup shows a compact, inspectable recommendation table. Metadata-only AI
output recommends correspondence, matching use, merge use, and source-specific
status; a human must explicitly accept it. Manual setup uses the same v2 model and
remains available after provider failure, timeout, or invalid output. Deterministic
warnings cover zero matching fields, name-only matching, a single signal, profiled
missing values, and an id-like source-local override.

Results lead with bounded counts and the uncertain-review action. Review asks
whether two records could be the same entity, displays evidence-derived agreement,
similarity, and contradiction first, and puts scores, feature values, blockers,
ranks, and versions behind technical disclosure. Alternatives, collision context,
defer/restore, undo, paging, and keyboard behavior remain intact.

Merge values starts with authoritative per-field totals from the compact run
summary. A user configures a deterministic rule, previews exact handled/unresolved
counts, and explicitly applies it before visiting paged exceptions. Saving never
applies. Manual resolutions continue to take precedence. Equal values create no
conflict; non-null cannot decide between two different populated values; selected
source rules preserve their existing no-fallback behavior; missing, invalid, or
tied recency timestamps remain unresolved; Preserve both completes the decision
without declaring either value canonical.

Export uses “Ready to export” and “Download reconciled data” while preserving the
existing readiness gate. The report and provenance manifest are secondary audit
files. The UI states that readiness covers surfaced decisions, not proof that every
real-world counterpart was discovered, and calls out intentional preserve-both
outcomes.

## Bounded data and provenance

No second storage model or unbounded conflict payload was added. `RunSummary`
includes bounded per-field conflict aggregates: mapping identity, label, total,
resolved, unresolved, and current policy. Individual results, review evidence, and
conflicts continue to use the existing paged/on-demand projections.

New mapping and AI contract artifacts are versioned. The run retains source
fingerprints, suggestion origin and provider/model/prompt/schema versions, human
accept/reject/edit state, final mapping flags, candidate/matcher versions, identity
decisions, policies, field resolutions, and export hashes.

## Known limits

Run state and decisions remain process-local; an API restart loses the current demo
run. Uploads remain limited to 2 MiB per file. There is no global assignment,
durable database, authentication, connector, queue, or AI row matching. Matching
quality remains a synthetic benchmark separate from ordinary uploaded runs, which
never receive fabricated precision or recall.
