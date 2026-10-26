# SW-029 — Blinded review-efficiency evaluation harness

## Objective

SW-027 made exact competing Dataset B candidates inspectable, and SW-028 hardened rapid actions, stale conflict refresh, undo and virtualized navigation. Those engineering tests **do not prove that a person reviews faster or more accurately**. SW-029 introduces an opt-in offline scorer and reproducible protocol for measuring real recorded review actions with withheld truth. It changes no product behavior.

## Inputs and trust separation

Run the study outside the public demo. Prepare two separately handled JSON files:

1. **Offline truth** (never shown to participants or sent to the review UI): `studyVersion`, `taskSetId` and `truth`, where each `caseId` has an independently adjudicated `expectedDecision` of `same_entity` or `different_entity`.
2. **Observed session traces**: `taskSetId` and `sessions`. Each session has a unique `sessionId`, pseudonymous `reviewerId`, matching `taskSetId`, a `standard_queue` or `collision_inspector` arm, and events. Events carry only `atMs` (nonnegative integer milliseconds since that session began), `caseId`, `action`, and, for `record_decision` only, `decision`.

Supported actions: `open_case`, `inspect_candidate`, `open_collision`, `record_decision`, `skip_case`. Complete or skip one case before opening another; do not interleave cases. `open_collision` is specific to the inspector arm. Every opened case must close. Reviewers may skip without guessing.

The CLI rejects invalid actions, nonmonotonic clocks, repeated cases, missing truth, mismatched task sets, extra payload fields or source-row content. It never changes Samewise's persisted human decisions.

### Example shape (illustrative, not a recorded experiment)

Offline truth file:

```json
{
  "studyVersion": "review-study-v1.0.0",
  "taskSetId": "study-task-set-001",
  "truth": [{ "caseId": "case-001", "expectedDecision": "same_entity" }]
}
```

Separately recorded events file:

```json
{
  "taskSetId": "study-task-set-001",
  "sessions": [{
    "sessionId": "local-session-001",
    "reviewerId": "pseudonym-001",
    "taskSetId": "study-task-set-001",
    "arm": "collision_inspector",
    "events": [
      { "atMs": 0, "caseId": "case-001", "action": "open_case" },
      { "atMs": 1000, "caseId": "case-001", "action": "open_collision" },
      { "atMs": 2000, "caseId": "case-001", "action": "inspect_candidate" },
      { "atMs": 4000, "caseId": "case-001", "action": "record_decision", "decision": "same_entity" }
    ]
  }]
}
```

These values merely document input structure; **they are not an observed result and must never be reported as product performance**.

## Execution

```text
pnpm study:sw029 -- path/to/offline-truth.json path/to/recorded-sessions.json
```

The command emits aggregate JSON to stdout and errors to stderr. It does not create or upload files, run the matcher, call OpenAI, send telemetry, or modify any run. Never commit real participant traces or sensitive source data to this repository.

## Output definitions

The scorer independently reports for each arm:

- Distinct reviewers and sessions; unique task cases seen; case observations; completed decisions; skips.
- Correct decisions and identity **false positives** (human SAME when truth DIFFERENT) and **false negatives** (human DIFFERENT when truth SAME).
- Decision accuracy = correct / decided; null when there are no decisions. Skips are excluded from this accuracy denominator and explicitly counted.
- Median elapsed time from `open_case` to `record_decision`, in milliseconds; excludes skipped cases. Pauses count as elapsed time.
- Candidate-inspection and collision-opening actions across **decided** cases, plus navigation actions per decision.
- Whether the two arms observed the same set of labeled case IDs. This is a descriptive coverage check, not evidence of randomized allocation.

Every result states that it is descriptive. The scorer produces no p-values, causal effects, business performance, precision/recall for the matcher, or synthetic reviewer timings.

## Controlled study protocol (future actual sessions)

1. Curate realistic, independently labeled cases spanning shared-B contention, near-ties, false similarities, duplicated occurrences, and clean controls. Freeze the exact task-set version and truth before sessions; never use held-out truth to alter matcher behavior.
2. Define standard queue and collision-inspector interfaces precisely. If either arm requires a different build or available feature set, document it. Preserve all decision safeguards.
3. Randomize/counterbalance reviewer assignment and task order. Use representative reviewers; avoid giving the same exact case twice without controlling for learning effects. Collect consent and no PII.
4. Instrument or consistently record elapsed monotonic session time and supported actions. This repository provides the **scorer only**, not automatic browser instrumentation or a completed user study.
5. Score each collected trace offline with truth held back from reviewers. Check coverage, skips, differing reviewer/case mixes, and order effects before interpreting arm differences.
6. Only after representative controlled sessions and error analysis may Samewise state any observed reviewer-speed or accuracy improvement, with exact sample sizes and limitations.

## Acceptance and exclusions

- Deterministic, testable aggregation with explicit denominators, correct false-positive/false-negative polarity, median timing, navigation counts and null/no-data handling.
- Adversarial tests for unknown truth, duplicate IDs, invalid decisions and events, incomplete or overlapping cases, nonmonotonic clocks, unsupported keys and deterministic replay.
- Standard `pnpm verify`, existing SW-022/SW-024/SW-025/SW-026 benchmark checks and production web build remain green.
- No production UI instrumentation, recording of uploaded CSV contents, truth sent to the app, automatic decision/replay, matcher/scoring/assignment change, new infrastructure, Railway access, manual deployment or production tests.

## Why this milestone exists

SW-027/028 make important engineering guarantees, but DOM counts, passing UI tests and optimistic descriptions are not human efficiency measurements. This harness establishes the measurement contract before making a claim that the inspector is faster or reduces mistakes. The study itself remains to be performed.
