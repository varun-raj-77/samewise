# SW-020 — Evidence-backed why/why-not identity outcomes

## Objective

For any Dataset A row in a completed reconciliation, answer what the recorded matcher and any subsequent human decisions actually establish. This is a read-only explanation surface: it does **not** recompute similarity, infer unseen candidates, run AI, or revise identity/survivorship.

## Contract and UX

- `GET /api/runs/:runId/identity-explanations/:aRowId` explains the established link if present, otherwise the leading retained candidate, otherwise a source-only record.
- `?bRowId=...` inspects a specific recorded pair or states explicitly that no scored evidence was retained for that pair.
- `IdentityExplanationSchema` is strict and versioned (`identity-explanation-v1`). It distinguishes automatic links, human SAME, human DIFFERENT, another selected candidate, pending review, retained alternatives, and no retained candidate. A human judgment is not falsely presented as an algorithmic conclusion.
- The results list has an on-demand **Why this result?** toggle for *every* Dataset A row, including the unmatched rows that previously had no clickable explanation. It displays up to six recorded field explanations, evidence contributions, matcher version, and opaque blocker IDs if available. Raw row records are intentionally omitted from this bounded summary. Full candidate evidence remains in the existing candidate detail endpoint.
- A matcher score is displayed as a recorded score, **not** a calibrated probability of identity.
- No retained candidate is explicitly **unknown cause**: lack of retained pair evidence does not distinguish failed blocking from pruning, no scoring, or an actual different entity. Do not claim to reconstruct the exact rejected blocking rule. The solution refuses to fabricate a negative match explanation.

## Acceptance and tests

- Given retained field evidence, classifications and field explanations are sourced from the frozen candidate and human decision store, not model prose.
- After SAME/DIFFERENT decisions, explanation changes appropriately while matcher evidence stays unchanged.
- An explicitly queried absent pair and a source-only row return `no_candidate_retained`, `none_retained`, and zero made-up field evidence.
- API validates requested IDs and rejects unknown Dataset A IDs. Read requests cannot alter run state.
- The results page remains paginated and on-demand, and the new UI works for unmatched rows.
- Tests cover pending, automatically linked, human confirmed/rejected, competing alternatives, omitted pairs, absent A rows and the web unmatched case. CI `pnpm verify` and the production web build must pass before merge.

## Known limitations

This is an honest *output-level* explanation, not a stepwise why-not trace through every blocking pass. Candidate generation does not currently retain per-pair rejection reasons or full eliminated pair sets; calculating those on demand would be costly and deceptive. Negative pair tracing, if pursued, needs explicitly bounded and measured diagnostic instrumentation with candidate recall safeguards.

The API follows the current development app's existing access pattern. **Do not expose uploaded real user data publicly without authentication and lifecycle controls.** No matcher algorithm or automatic thresholds change here. Global one-to-one conflict handling remains the next distinct milestone.

## Exclusions

No fabricated match metrics, production infrastructure mutation, database provisioning, new job queues, raw file rewrite, AI matching, automatic value selection, or PR merge without exact-head approval.
