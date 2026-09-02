# SW-009 retained evaluation evidence

`catalog.json` contains two content-addressed snapshots and their compatible direct
comparison on `organizations-matcher-holdout-1200-v1`. Each snapshot directory keeps
the immutable snapshot plus a separate error artifact. The accepted v0.2 snapshot
passes `matcher-quality-gates-v1.0.0`.

Regenerate with the `samewise-matcher evaluation run` command documented in
`docs/sw-009-evaluation.md`. Identical versioned inputs must reproduce the same
snapshot IDs and SW-006 denominators. A mismatch is artifact/configuration drift to
investigate, not a reason to update expected facts casually.

This directory is checked-in benchmark evidence. Write exploratory runtime outputs
under ignored `.samewise-data` paths.
