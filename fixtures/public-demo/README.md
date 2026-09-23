# Public demo fixture

`apps/web/public/samples/` contains the two runtime-visible CSV source files. This directory is test-only: `ground_truth.json` documents the intended 24 overlapping vendor identities and the four source-only records on each side. Product runtime, candidate generation, and matching never read this truth file.
