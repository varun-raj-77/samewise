# Result-state consistency audit plan

Status: audit completed before product-state changes.

## Findings

- Matcher `onlyA` means no A-side candidate survived the review threshold.
- Matcher `onlyB` means no B-side record has an automatic link yet. It therefore
  intentionally includes B records participating in unresolved review pairs.
- `WorkflowStore.view()` preserved that internal representation for exports, but
  copied its size directly into the primary `No match found in Dataset A` summary.
  This double-counted unresolved review B records in user-facing workflow states.
- A-side primary state was already mostly exclusive because review A rows never
  entered matcher `onlyA`; exhausted human DIFFERENT decisions were added later.
- Review-queue construction could include an automatically matched A row when the
  matcher retained lower-ranked alternatives. That is another state-projection
  issue, not matcher behavior.

## Focused implementation

1. Derive primary matched, unresolved-review, deferred, and no-match sets from
   authoritative candidates and decisions on both A and B sides.
2. Keep matcher/internal `onlyA` and `onlyB` arrays unchanged for reconciliation,
   trusted-export, and manifest compatibility. Only the compact product summary
   receives mutually exclusive workflow counts.
3. Exclude untouched automatic matches from the review queue even when alternatives
   were retained. A human rejection of the automatic candidate still advances to
   an undecided alternative normally.
4. Add transition tests for automatic, unresolved, deferred, SAME, exhausted and
   non-exhausted DIFFERENT, collision, and equivalent batch/individual decisions.
5. Add product-state counts to the deterministic workload harness while retaining
   raw matcher projections as technical evidence.
6. Rerun all locked matcher/generalization artifacts and the full repository gate;
   matching metrics must remain unchanged.

