# Benchmarks

Versioned benchmark configurations and manifests record generator/config versions,
requested and actual counts, filenames, and content hashes. The checked-in
`organizations-dev-v1/candidate-snapshot-v0.1.0.json` gates stable correctness and
candidate counts. Runtime is not frozen because it is hardware-dependent. Any
candidate behavior change requires fresh comparison against the snapshot and the
generated 1K/10K configs.

The weak-identifier config and v0.2 falsification snapshot add a second gate where
exact phone, email, and domain rarely survive. Generated CSV/truth artifacts remain
ignored; only compact configuration, reports, and correctness snapshots are kept.

SW-006 adds separately seeded 1,200-entity tuning and holdout weak-identifier
configs. Runtime splitting is forbidden: the tuning/holdout boundary is fixed by
fixture name and seed before scoring work. The holdout evaluator requires a frozen
matcher config naming a different tuning fixture.
