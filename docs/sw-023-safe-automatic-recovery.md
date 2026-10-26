# SW-023 — Recover automatically linkable records through safe assignment propagation

## Objective

SW-022 revealed a consequential cost of SW-021's blanket ambiguity rule on a frozen synthetic holdout: 169 correct baseline auto links became 89, sending 80 additional A records to human review without reducing false auto links in that fixture. Keep the one-to-one guarantee, but allow a previously disputed B to become uncontested **only after every other A that retained it is independently assigned to a different B**.

This is deterministic constraint propagation, **not** maximum-weight bipartite matching, threshold tuning, or a claim of ground-truth identity.

## Implementation

- `automaticIdentityCandidateIds` uses every final retained A→B pair to construct the possible B owners, then accepts only each A's unique rank-1 `auto_match` proposal with no explicit `collision` hint.
- Find initially uncontested rank-1 proposals. When an A is assigned to its B, it cannot also own alternative B records; subtract that A as an alternative owner from those B records. If exactly one owner remains and its unique ranked proposal is eligible, accept that proposal; repeat until no new anchors are available.
- Never assign the same A or B twice. Never choose among two remaining automatic contenders for one B. Reciprocal cycles, unresolved alternatives, duplicate rank-1 proposals and explicit collision flags stay in human review. Scores, candidate evidence and matcher versions are immutable.
- Time/space for the selector is linear in the retained candidate graph (except input order and iteration metadata). No quadratic all-pair comparison.
- Human `SAME` decisions take precedence and reserve both their A and B. Human `DIFFERENT` decisions remove that candidate as a supporting automatic anchor; dependent automatic links return to review. Review queue and why-result explanations recompute from that decision-aware assignment state. Undo can restore eligible automatics.
- As before, only established identity links produce field-survivorship conflicts. Export derives from the same versioned selector, not a separate heuristic.
- `conservativeAutomaticIdentityCandidateIds` freezes the historical SW-021 behavior, and `legacyAutomaticIdentityCandidateIds` freezes pre-SW-021 behavior. SW-022's historical benchmark and saved report retain the same meaning.

## Evaluation and acceptance

- Adversarial unit cases: one alternate B owner already anchored elsewhere, multi-hop propagation, input-order permutation, true duplicate-B auto competition, reciprocal cycles, stale explicit collision flag, malformed double-rank-1, and human decision overrides.
- API integration: automatic recovery has no review cases and creates field conflicts; rejecting its supporting auto anchor safely withdraws dependent links and updates review/explanations; undo can restore them.
- CI runs the normal repository verification, the unchanged `pnpm benchmark:sw022`, the new `pnpm benchmark:sw023`, and production web build.
- SW-023 comparison uses identical deterministic dev and held-out synthetic fixture matcher results for frozen SW-021 and propagated SW-023. Truth is used **only after** matching. Report source/truth/mapping digests, correct/false auto matches, review burden, duplicate B claims, final retained candidate recall and isolated selector runtime; do not invent business/production metrics.
- On these fixtures, fail CI if SW-023 introduces an automatically assigned false link or duplicate B claim compared to SW-021. These fixture gates do not prove false-positive safety universally.

## Tradeoffs and constraints

If an existing anchor is wrong, propagating from it can also be wrong. Therefore the result must be interpreted as **structurally one-to-one**, not absolute ground-truth correctness. Future independent collision-heavy labeled fixtures and actual human review labels are needed before asserting broad precision gains.

The underlying synthetic holdout has duplicate canonical-entity occurrences; there can be multiple true cross-source pairs but only one allowed exported match per A/B. We continue to report final-retained candidate recall (not the earlier blocking-stage recall). No hidden forced winner, extra model call, source mutation, survivorship override, threshold change or training on holdout truth is allowed.

No external queues, hosted infrastructure, production tests, manual deployment or Railway access.
