# SW-048 — Keep merge-plan previews tied to the chosen policy

## Problem

The Merge values view separates a dry-run preview from the user's explicit
Apply action. Previously, editing a field rule cleared the visible preview,
but an older in-flight preview could finish afterward and repopulate the UI.
The field selectors also remained usable during a pending request. A reused
component could retain unsaved rules from another reconciliation, and a late
Apply response could update the app with that earlier run.

Those cases contradict the product boundary that the preview must describe
the *current* policy and the explicit Apply must update only the active run.
The backend's preview-token check remains the authoritative protection; this
milestone closes the client-side evidence and navigation gap.

## Acceptance criteria

- Every rule edit, source/timestamp option edit, and manual resolution
  invalidates an earlier preview generation. Responses from invalidated
  generations cannot restore preview details or announce obsolete counts.
- Field rules, trusted-source options, timestamp selectors, and safe rule
  suggestions are disabled while a merge-plan operation is pending.
- The preview response must identify the requested run. An Apply response
  must also identify that run before the app accepts its updated summary.
- Switching reconciliations drops the previous preview and unsaved draft
  rules, even when returning to a previously visited run ID. Late preview,
  Apply, or manual-resolution responses must not replace a new run's state
  or clear its pending busy indicator.
- An unchanged, valid preview continues to require an explicit Apply action.

## Verification

`apps/web/src/SurvivorshipWorkspace.test.tsx` covers delayed preview
completion after a draft edit, cross-run preview rejection, pending control
lock, old Apply completion after run switch, draft reset, and foreign Apply
response rejection alongside the existing successful preview/apply workflow.
The first three newly characterized cases failed before the fix; the late
Apply and draft reuse cases were also observed failing as each was added.

Reviewers should check request-generation invalidation around all rule
changes and manual resolutions, and ensure that a valid preview still applies
normally. The full repository verification suite and production web build
remain mandatory gates.

## Risks and exclusions

This protects browser state; it does not promise cancellation of an HTTP
request already received by the server. Backend preview tokens, source data,
identity decisions, policy semantics, matcher behavior, and export gates are
unchanged. No Railway, database, deployment, or production-test work is part
of this milestone.
