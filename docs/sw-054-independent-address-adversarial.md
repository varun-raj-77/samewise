# SW-054 — Independent adversarial address and identity audit

## Why this is necessary

SW-052 showed that name-independent street+locality candidate generation recovers true links in a **constructed** recurring synthetic pattern. SW-053 then scored those candidates with the unchanged matcher and observed no additional false automatic matches in the same fixture. Neither experiment established real-world safety: both share one data-generation hypothesis.

SW-054 tests independent, hand-authored identity histories, including **unrelated businesses with moderately similar names sharing one address**, rebrands, replacements, relocated organizations, two rebranded occupants at the same building, missing geography, different cities, similar street numbers, and conflicting confirmed state mappings. A source-only entity can legitimately have **no** true cross-source link. That is vital to avoid false confidence from the previous fixture's guaranteed 1:1 overlap.

## Evaluation isolation

The 12 explicit scenarios are written as labeled records, but the actual candidate generation, probe, unchanged frozen scoring, and result assembly consume only visible source fields. Canonical entity labels are used **only after** results are built to measure correct and incorrect identities. The name-independent probe remains evaluation-only and carries a unique provenance marker on incremental candidates.

The test suite checks the current behavior, including unsafe behavior, instead of silently changing the production matcher to make tests green.

## Findings: four new incorrect automatic matches

On 2026-11-11 ET / 2026-11-12 UTC, GitHub Actions [push CI #43131238938](https://github.com/varun-raj-77/samewise/actions/runs/43131238938) passed the 12 independent scenarios at tested commit 01be8efebba13742dc68d255b941f4b5b9d11675. The evaluated code is the hypothetical address-only pass plus the existing v0.3 matcher scoring/decision policy, not deployed product behavior.

| Explicit hand-authored scenario | New false auto-match score | Baseline candidate? |
| --- | ---: | --- |
| Alpha Analytics / Aloha Facilities — unrelated office tenants | 0.622746 | No |
| Harbor Consulting / Horizon Contractors — replacement tenant | 0.571795 | No |
| Same address and city but confirmed state conflict | 0.546211 | No |
| Velocity Transport / Veracity Trading — source-only unrelated tenants | 0.623228 | No |

**All four are different canonical entities.** All four pairs were admitted by the evaluation-only address pass and auto-matched incorrectly by the **unchanged matcher rules** once admitted. These are counterexamples sufficient to invalidate a categorical *zero additional false auto-matches* claim; they are **not** representative false-positive rates.

The current probe's separate-key treatment of geography admits a pair when city matches despite a conflicting confirmed state. That is a correctness risk independent of the name-similarity score.

The same-name-unrelated scenario also yields an incorrect automatic match in the **existing baseline** without the experimental blocker. This is recorded separately (1 baseline false auto, 0 incremental false autos). It deserves later attention, but must not be attributed to this address-rescue experiment.

A legitimate same-location rebrand was recovered, and relocated entities, mismatched street names/cities, or missing locality did not gain an address-only candidate in these targeted cases. This does **not** offset the safety failures.

## Release decision gate — not safe to activate automatically

Address-only candidate admission must not implicitly qualify a proposed pair for auto-match merely because its name is somewhat similar and its street and city agree. These are plausible recurring business patterns, not exotic catastrophes.

Before a product implementation can be considered:

- Explicitly distinguish probe-only candidate provenance and evaluate a **review-first** policy for address-only admissions, including when original blockers also fire.
- Handle confirmed **city plus region** carefully; accepting one geography mapping despite a disagreement in another can admit cross-state lookalikes.
- Measure the candidate-recall loss caused by stricter caps alongside changes in false auto-match rates and human review demand.
- Use a genuinely independent held-out fixture and multiple corruption distributions; merely shuffling source rows is not sufficient.
- Require matcher/review evaluation with false-positive/negative denominators, reproducible manifests, and no hidden truth in production paths.

SW-054 is evaluation only. No production blocker, matcher thresholds, source data, identity decision, survivorship logic, API, or deployment configuration is altered.

## Run

    uv run --project services/matcher pytest services/matcher/tests/test_address_adversarial.py -q
    uv run --project services/matcher python -m samewise_matcher.address_adversarial
    pnpm verify

The CI job also runs the unchanged existing matcher benchmarks and SW-052/SW-053 evaluations. Independent review is still a release gate.

## Interpretation

An observed **new incorrect automatic match** in one of these scenarios would invalidate the previous reassurance of zero additional false auto-matches; it does **not** mean the currently deployed matcher has newly developed that failure, because the proposed address-only blocker is not enabled in product generation. A false automatic match on a pair already generated by the original blockers is reported separately from one caused by admitting a new address-only pair.

Any numeric results must cite the exact tested commit and CI log rather than treating these hand-picked cases as population-level rates.
