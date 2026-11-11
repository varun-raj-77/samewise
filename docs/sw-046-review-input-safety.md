# SW-046 — Review input ownership and pending-action safety

## Objective

Prevent unintended human identity decisions from global keyboard shortcuts and keep the review context stable while an identity mutation is awaiting an authoritative API response.

## Observed failure before the fix

The individual review workspace installed `keydown` on `window` and ignored only text inputs, select boxes, and editable content. A non-repeating `S` or `D` event targeted at a focused button could therefore record a human identity decision. The handler also stayed mounted when the app's **New reconciliation** confirmation was open, allowing a window-level key event to decide the underlying case through the modal.

Independent regression tests reproduced both unintended decision submissions against the previous implementation. They passed after the guard was added.

## Changes

- **Keyboard ownership:** Individual review shortcuts are suspended while a native or ARIA-modal dialog is open; keys originating in or focused on interactive controls are left to those controls. Focus outside the individual review workspace also suspends its shortcuts. Normal `S`, `D`, `E`, `U`, `J/K`, and candidate-number shortcuts remain available while focus is in ordinary review content. Repeat-key, modifier-key, hidden-group, loading, and mutation guards remain in place.
- **Pending individual actions:** Candidate switching, view switching, search, filters, sorting, and pagination are disabled while the review mutation is pending. Existing synchronous mutation locks continue to guard the handlers before React has committed a disabled state.
- **Pending batch actions:** Group selection, sample inspection, individual-review navigation, confirmation checkbox, and completion navigation are disabled during batch mutation or undo. The server remains authoritative; there are no automatic retries.

## Acceptance evidence

1. Focused review buttons and globally dispatched keys behind an open confirmation dialog cannot submit identity decisions. A direct App regression exercises the real New reconciliation confirmation.
2. A shortcut still works normally when the dialog closes and focus returns to review content.
3. During an unresolved individual decision request, the selected case and queue context cannot be changed through candidate buttons, group navigation, search, filter, or sort controls.
4. During an unresolved batch request, other groups and individual cases cannot be opened and the confirmation checkbox cannot be changed.
5. Full repository verification, production web build, and pull-request CI must pass before merging.

## Boundaries

This is user-input safety hardening, not evidence of improved reviewer speed or accuracy. It does not change candidate generation, matching scores, server-side decision validation, one-to-one policy, source datasets, survivorship, exports, persistence, or deployment infrastructure. Browser and server concurrency in separate tabs remain governed by the existing API revision and conflict rules.
