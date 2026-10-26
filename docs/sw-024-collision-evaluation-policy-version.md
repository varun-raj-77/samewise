# SW-024 — Independent collision evidence and assignment-policy pinning

## Why this milestone exists

SW-022's held-out synthetic benchmark showed that the SW-021 conservative one-to-one rule sent 80 additional correct automatic links to review on that fixture, without reducing false automatic links in that fixture. Experimental SW-023 recovered only 1 of those links. The project must not abandon one-to-one integrity to optimize a single measured review-rate metric. It must also not reinterpret historical saved runs when a selector is replaced.

This milestone is intentionally **not** a new matcher or a promoted alternative selector.

## Scope A — independent synthetic collision challenge set

The source file `evaluation/fixtures/sw-024/independent-collision-cases-v1.json` is **hand-authored synthetic candidate-graph test data**, distinct from the organizations-dev/tune/holdout fixtures. It carries 12 explicitly described scenarios. These include:

- Two automatic claims to one B when one claim is incorrect
- A harmless lower-ranked candidate sharing another A's otherwise safe B
- Reciprocal cycles where global uniqueness is genuinely unresolved from graph structure
- Lower-confidence competitor to a correct high-confidence link
- A unique but *incorrect* automatic link (shows one-to-one constraints do not ensure truth)
- Duplicate occurrences of one canonical entity (real truth can be many-to-one even though product mode is not)
- Explicit matcher collision hint, review-only candidate, uncontested exact link, malformed duplicate rank-one proposals, absent true pair, and partly duplicated truth

The fixture contains **no real users or uploaded records**. It stores only minimal A/B row identifiers, manually defined canonical-entity labels, and mock matcher rank/band/collision flags. It does **not** run the Python matcher. Consequently these cases are adversarial assignment-policy tests, **not an independent measured real-matcher precision estimate**.

`pnpm benchmark:sw024` validates the catalog with strict Zod schemas and evaluates both frozen pre-SW-021 and SW-021 selectors **on each identical candidate graph**. The true entity labels are used only to calculate outcomes. The generated fingerprinted JSON in `evaluation/reports/sw-024/latest-ci.json` reports counts, true/false automatic links, duplicated B claims, review cases, and final-retained truth-pair coverage.

Pooled precision is calculated from pooled numerator/denominator, never averaged across scenario percentages. Undefined precision is `null`. A few deliberately difficult, hand-authored cases are not a representative sample, so the aggregate must **not** be advertised as predictive product precision.

## Scope B — per-run identity assignment-policy version

Matcher, candidate engine and mapping versions already exist but do not identify the **post-scoring assignment rule**. We now pin the separate `assignmentPolicyVersion` to each run's persisted state, with the closed value `assignment-one-to-one-conservative-v1`.

- Every new run persists that value. The strict public run summary and view expose it as provenance without changing matching decisions.
- Historical pre-SW-024 snapshots with the field absent are unambiguously interpreted using the same SW-021 conservative rule under which they were created. The read path does not rewrite their bytes; a future normal mutation writes the explicit pin.
- A snapshot containing an unrecognized policy version **fails closed on restore**. No silent fallback to the newest selector.
- Both active output selection and export use the pinned selector; version validation is centralized at `automaticCandidatesForPolicy`. No future migration may change `assignment-one-to-one-conservative-v1` semantics retroactively.
- Do **not** equate version-pinning with universal reproducibility: code/config hashes, exact dependency versions and human judgment provenance still matter.

Important: A future assignment implementation requires a **new** version identifier and an explicit migration/new-run decision. Version-pinning does not authorize changing existing human decisions or re-exporting old runs using new semantics.

## Gates / acceptance

1. `pnpm verify`: TypeScript checks, API/frontend tests and Python tests pass, including legacy snapshot fallback, unsupported-version refusal, unique collision case identifiers, harmful harmless and truth-duplicate comparisons.
2. The existing `pnpm benchmark:sw022` must remain unchanged. Independent `pnpm benchmark:sw024` runs on CI and builds a reproducible JSON report from its committed fixture.
3. `pnpm --filter @samewise/web build` passes.
4. No matcher scoring or review thresholds changed; the conservative one-to-one assignment policy remains active.
5. No source mutation, field-survivorship rewriting, model calls, queue/storage architecture changes, manual deployment, production testing, or infrastructure access.

## Next decision

Design a larger separately seeded *actual matcher-input* collision suite with audited truth, once per-run policy migration is proven. Compare candidate generation recall, auto-match precision, review burden, and false negative cost across both duplicate and unique-record modes. The experimental SW-023 algorithm is still not justified for production by one recovered match.
