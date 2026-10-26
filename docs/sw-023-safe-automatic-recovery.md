# SW-023 — Investigate safe automatic-match recovery (experimental, not enabled)

## Motivation and measured result

SW-022 established an important product cost: the SW-021 one-to-one rule deferred 80 previously correct auto links to human review on a frozen synthetic organizational holdout without reducing false automatic links on that fixture.

SW-023 tested deterministic propagation of existing, uncontested automatic anchors as an alternative to SW-021's more conservative global ambiguity check. On the exact same checked-in synthetic holdout, the experimental algorithm recovered **1 of the 80** deferred correct links. The other **79 remain deferred**.

| Holdout (1,044 A and 1,044 B rows) | SW-021 | Experimental SW-023 |
|---|---:|---:|
| True auto links | 89 | 90 |
| False auto links | 0 | 0 |
| Candidate-bearing A rows routed to review | 849 | 848 |
| Auto precision | 89/89 (100%) | 90/90 (100%) |
| Duplicate B claims | 0 | 0 |
| Final-retained true-pair recall | 866/879 (98.52%) | unchanged |

A separate dev smoke fixture (23 A, 22 B) showed no difference: 12 true auto links under both policies.

The CI exclusion breakdown is informative: **all 80 original deferrals had another A row retaining the same B candidate**. None were due to explicit matcher collision flags or duplicate rank-1 automatic proposals. Exactly one case could be unambiguously released by existing anchors. The rest need a policy choice or human review.

These values are synthetic-fixture observations only, **not production metrics or universal precision guarantees**. A false supporting anchor could yield an incorrect propagated link on another fixture. The current CI policy benchmark is a diagnostic, not proof of generalization.

## Release decision

**Do not enable this experimental assignment policy in production.** SW-021's conservative selector remains the only live behavior in `automaticIdentityCandidateIds`, while `experimentalPropagatedAutomaticIdentityCandidateIds` is benchmark-only. The API, results, review workflow, trusted exports, and stored run states are unchanged.

This decision is not merely about the small measured improvement. Historical run snapshots currently preserve the matcher/mapping/config versions but do not pin an explicit global **identity-assignment policy version**. Silently swapping selectors would reinterpret an old run when reopened, violating Samewise's reproducibility guarantees. A future deployment must store and honor the assignment policy version used when the original run was created, and must avoid implicit migration of historical decisions.

## Experiment design

The experimental selector:
1. Builds candidate ownership of each B from **all retained pairs**; neither truth labels nor AI decisions enter the selector.
2. Accepts only unique rank-1 `auto_match` proposals with no explicit collision flag.
3. Removes alternative B claims of an A already safely assigned elsewhere and repeats constraint propagation while ownership is uniquely determined.
4. Never chooses between remaining competing rank-1 contenders, duplicates B ownership, overwrites human judgments, or uses score-based global greedy assignment.
5. Is deterministic across input permutations for graph structure and uses work-queue propagation rather than quadratic candidate comparisons.

Adversarial tests include chains, reciprocal cycles, competing B claims, explicit collision hints, malformed duplicate rank-1 proposals, and hypothetical human constraints. These are **experimental selector tests**, not tests claiming the live product adopted it.

## Reproducibility

```sh
pnpm install --frozen-lockfile
uv sync --project services/matcher --locked
pnpm benchmark:sw022
pnpm benchmark:sw023
pnpm verify
```

CI executes both benchmark commands and a production web build. SW-022's old selector remains frozen and keeps its historical semantics. SW-023 runs the exact same current Python matcher on synthetic dev and holdout inputs, then compares assignment policies post hoc; truth never reaches the matcher. The JSON report includes source, mapping, and truth SHA-256 fingerprints and a non-additive breakdown of deferred reasons.

## Next high-value milestone

Before changing live outcomes, build **additional independent labeled adversarial fixtures** focusing on shared-B collisions and duplicated entities; instrument distinguishable collision patterns and compare precision, review burden, calibration and abstention at a fixed candidate recall. Add a durable per-run assignment-policy version (plus backward-compatible SW-021 semantics) before any product-selector migration.

Do not relax one-to-one uniqueness, silently force a global optimal assignment, or tune to the already-observed holdout. No Railway access, hosted infrastructure changes, manual deployment, or production testing was performed.
