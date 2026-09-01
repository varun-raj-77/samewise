# SW-007 review workspace

## Queue state model

Each item represents one A-side identity problem and retains stable A and candidate
IDs. The API derives it from the immutable matcher result plus human product state:

- `needs_review`: at least one retained candidate is still undecided;
- `deferred`: unresolved, intentionally removed from the active sequence;
- `reviewed_same`: a human SAME establishes the effective A/B identity link;
- `reviewed_different`: every retained alternative has a human DIFFERENT decision.

System auto-matches are effective system proposals. They are not stored or styled
as human SAME decisions. Candidate membership is not an identity link. Deferred
items remain unresolved and remain in the result-level Needs Review count.

Overall progress is computed from the entire per-A review queue. `reviewed` counts
the two reviewed states, `remaining` counts active unresolved items, and `deferred`
is separate. When a filter is active, the UI labels its visible count separately
from the overall total.

The deliberate default order is smallest top/runner-up margin first, then higher
top score, then stable source order. This puts the most ambiguous ranking decisions
first. Reviewers can instead sort by score, candidate count, or source order and
filter for deferred, collision, contradiction, or multiple-candidate cases. Search
is deferred and limited to row IDs and mapped name values.

## Candidate alternatives and evidence

Selecting ranks 1–3 changes only local UI selection. It never calls a decision
endpoint. Each option displays B row ID, rank, match score, strongest agreement,
and a weighted contradiction when present.

The comparison area uses the actual SW-006 `FieldEvidence` objects. Raw A and B
values remain primary. Normalized values appear only when non-empty and different
from raw. Labels are deterministic projections:

- `exact_agreement` → Exact;
- `partial_agreement` → Strong agreement when the strongest stored feature is at
  least 0.85, otherwise Partial agreement;
- `conflict` → Conflict;
- missing classes → Missing A, Missing B, or Missing both.

The underlying weight, positive/conflict contribution, feature values, matcher
explanation code output, blocker provenance in the candidate payload, and complete
raw records remain available. No AI prose is generated. Match score is always
called an evidence score, never a probability.

## Identity actions, defer, and auto-advance

Actions apply to the selected A/B candidate:

- SAME records human evidence and creates comparison-field conflicts afterward.
  Every new conflict has a null resolution; no value survives automatically.
- DIFFERENT creates no conflict and does not consume another alternative. If an
  undecided alternative remains for the same A row, it becomes the next candidate;
  otherwise focus advances to the next active A-side item.
- DEFER marks the A-side item process-locally, advances to the next active item,
  and can be reversed from the Deferred filter.

The UI waits for a validated server response before announcing success or moving.
Focus then moves to the new case question.

## Undo semantics

The API retains the 20 most recent process-session human identity decisions. The UI
offers the newest entry. DIFFERENT is removed directly. SAME removes only field
conflicts that were created by that decision. If any such conflict already has a
manual field resolution, undo is blocked with an explicit explanation; the identity
decision, conflict, and resolution are all preserved. Conflicts that existed for a
system auto-match are never removed by undoing a later human confirmation.

This is intentionally not command sourcing and is lost with the API process.

## Collision behavior

The selected B row is compared with every retained candidate and effective link.
The warning distinguishes a shared candidate from an already effective competing
link and provides navigation to competing review cases. Samewise does not silently
reassign or overwrite another human decision. Current runtime semantics do not
enforce global one-to-one identity, and the UI says so explicitly; no global or
Hungarian assignment was added.

## Keyboard and accessibility

- `S`: SAME
- `D`: DIFFERENT
- `E`: defer/skip
- `U`: undo the eligible recent decision
- `J` / `K` or Down / Up: next / previous visible review item
- `1` / `2` / `3`: select candidate rank

Shortcuts ignore input, textarea, select, and editable targets and do not override
modified browser shortcuts. Queue rows, alternatives, and actions are native
buttons/inputs with accessible names and selected/current state. Evidence and queue
states contain text and symbols rather than relying on color. Successful actions
use a polite live region. Case headings receive focus after selection, decision,
defer, or undo. Focus styles are visible, details work without hover, and reduced
motion is respected.

## Virtualization and performance evidence

The queue uses a small Samewise-owned fixed-row window: scroll offset and viewport
height determine the visible slice, with five rows of overscan on each side. A
spacer preserves the full scrollbar; rows are keyed by A row ID and absolutely
positioned. No data-grid or state/query dependency was added.

`VirtualReviewQueue.test.tsx` constructs 10,000 deterministic review summaries and
asserts that the spacer represents all 10,000 while fewer than 30 row components
are mounted. This is bounded-render evidence, not a latency claim. Filter/sort
tests separately assert deterministic behavior. Actual 100K product behavior is
still unmeasured.

## Route recovery and limitation

The browser stores only `run` and `screen` in the URL. On refresh it retrieves the
authoritative `RunView` from the API and rebuilds transient selection locally. If
the API restarted, the route explains that the run is no longer available. Uploads,
decisions, defer state, and undo history remain process-local; SW-007 adds no database.
