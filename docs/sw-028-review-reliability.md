# SW-028 — Review workflow reliability and large-queue safeguards

## Objective

SW-027 made exact Dataset B collision contenders directly inspectable, including A candidates outside the current server-paginated queue page. SW-028 hardens this workflow against stale reads, rapid duplicate decision requests, pagination position changes and concurrent changes to a reconciliation. This is a bounded engineering milestone, not a claim that humans now review faster.

## Changes

- **Synchronous mutation lock:** local in-flight ref is set before awaiting a decision, defer, undo, or batch operation, closing the gap before parent `busy` props re-render. Keyboard shortcuts and visible actions share the same guard. The API remains authoritative, with 409 rejections for duplicate/conflicting decisions.
- **Stale-revision recovery:** the web app makes a read-only `GET /api/runs/:runId` following a rejected review mutation with HTTP 409; it replaces its displayed run projection with the authoritative state and surfaces the original error. It **never automatically retries** an identity decision, undo, defer or batch.
- **Off-page contender pin:** selecting a competing A from exact B collision context temporarily preserves that case across an unrelated queue-page refresh. Deliberate queue selection, paging, filtering or search clears that pin. Completion of a decision releases the pin. Undo explicitly returns to the candidate that was undone, even if it is off the current page.
- **Stale collision display:** while the collision list is refetched after decision/undo or navigation, previous claimed-by and human-decision labels are hidden until the latest bounded response is parsed.
- **Large queue stability:** a server-side queue page remains bounded at 50, with DOM virtualization. Filter/page changes reset a scrolled viewport to its start and clamp the visible window when the number of records shrinks. Existing deterministic 10,000-item synthetic DOM test bounds mounted rows; an added test exercises the transition from a far scroll position to a short filtered page.

## Reliability acceptance

1. Repeated mouse/keyboard activation while the same decision is pending issues only one decision request.
2. A conflict error (409) reloads the authoritative run **once**, preserves the original error message and does not retry the decision.
3. Inspecting an off-page B contender stays on that A through a queue refresh; deliberate navigation changes it.
4. Virtualized large queues do not mount thousands of rows at once. Switching to a smaller page does not leave the user looking at a blank or wrongly scrolled queue.
5. All existing review, undo, same/different, identity one-to-one integrity, field conflict, SW-022/SW-024/SW-025/SW-026 benchmark, build and typecheck tests remain passing.

## Measurement boundary and exclusions

Tests measure deterministic **mounted row counts, request counts and state transitions**, not reviewer throughput in people/minute, precision improvements, latency percentiles, memory utilization or new business metrics. Real human review-speed and error-rate comparisons still require a controlled study with representative labeled cases and timed tasks.

No matcher scoring, blocking, assignment cardinality, persisted identity decisions, source datasets, field resolution logic, external services, manual deployments, Railway access, or production tests are changed.

## Risks

Local locking prevents same-tab duplicate requests, but does not serialize requests from other tabs/devices; server persistence revisions and one-to-one checks remain the source of truth. A client may not know whether an interrupted network request committed; therefore an unconfirmed request must be reconciled with a fresh server read, not automatically replayed. Test long-running navigation and retry states in browser tests before claiming live production readiness.
