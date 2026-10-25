# SW-021 — One-to-one identity safety and collision review

## Problem

A high individual match score is **not** a globally consistent assignment. Previously, the same Dataset B row could appear in multiple automatic effective links, or a reviewer could confirm two different Dataset A rows against the same B record. The UI warned about a shared-B collision, but the authoritative effective-link and trusted-export path did not enforce one-to-one identity.

This milestone sets **one Dataset A record ↔ at most one Dataset B record** as a product invariant for the current reconciliation mode. It does not assume that a many-to-one relationship is invalid in every imaginable matching workflow; that would require an explicit alternate mode.

## Behavior

1. Build the cross-row collision set from **all retained candidate pairs**, independent of matcher rank or whether the matcher sets the optional collision hint. If two distinct A records retain the same B candidate, none of those candidate links are silently accepted automatically.
2. Preserve original matcher candidates, scores, bands, blocking evidence and versions unchanged. Global collision safety is a separate assignment layer; no rescore, no automatic winner selection.
3. Demote affected auto proposals to **Needs review**, including auto proposals that have no `needs_review` band in the matcher output. In UI, they still carry their recorded `auto_match` scorer band for provenance.
4. A human may explicitly confirm one contender. Any attempt to confirm the same B for another A receives a 409 `b_row_already_confirmed` **before writing the second decision**. A DIFFERENT decision remains possible. A same-A double confirmation is also prohibited.
5. Compute effective links from a single selector shared by API summaries, field-conflict creation, evaluation views, reconciliation exports and trusted output. Human SAME is authoritative, while **uncontested** auto matches can be accepted.
6. A corrupted persisted snapshot with two human SAME claims for one A or one B fails closed with `one_to_one_integrity_violation` rather than choosing a hidden winner. No automatic reconciliation of historical human judgments occurs.
7. Keep identity decisions separate from field survivorship. Comparison-field conflicts are created only for established identity links; the trusted export remains blocked while any collision review remains unresolved. No source datasets are rewritten.
8. Fix adjacent undo correctness: a SAME judgment on an already-auto-linked candidate can inherit an existing conflict. Undo is blocked when that conflict has an applied resolution; after clearing it, undo restores system provenance.

## Acceptance tests

- Adversarial injected matcher result with two auto-scored A→same-B pairs, **even with false collision hints**, produces zero auto links, two review cases, no system-created comparison-field conflicts, and no trusted-ready export.
- One human SAME is accepted, the second claim for the same B is rejected without any persisted decision, DIFFERENT resolves the other review, and trusted export has exactly one cross-source link and no B duplicate.
- Existing uncontested auto candidates stay automatic without unnecessary review.
- Human SAME followed by field resolution prohibits undo; clearing the resolution permits undo and restores previous automatic provenance.
- Batch safety, replay, persisted jobs, matcher tests and the web production build remain passing.

## Scope and deliberate exclusions

This is **constraint enforcement and human conflict resolution**, not a max-weight bipartite matching solver. A global optimal assignment would need a separately benchmarked objective, ties policy, abstention logic, and a proof that error/review tradeoffs improve on frozen labeled fixtures. Samewise deliberately does not silently force a global pairing when evidence is ambiguous.

No schema migration, generic MDM modeling, async infrastructure changes, field overwrites, ML retraining, raw source mutation, or production side effects.
