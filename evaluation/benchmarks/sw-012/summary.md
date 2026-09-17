# SW-012 bounded projection benchmark

The real `organizations-candidates-10k-v1` fixture was uploaded and matched through
Fastify with the normal Python subprocess. The unchanged matcher produced the same
56,892,493-byte baseline result and SHA-256 recorded by SW-011. The match endpoint
now returned an 8,386-byte `RunSummary` (99.985260% smaller), while the largest
initial bounded browser list was the 50-item review page at 88,351 bytes
(99.844705% smaller). A complete selected-candidate evidence response was 7,468
bytes and was requested separately.

The benchmark exercised SAME, DIFFERENT, undo, defer/restore, candidate-rank
inspection without mutation, conflict resolution/clear, human evaluation evidence,
and repeated deterministic reconciliation export. All checks passed. Repeated
export bytes were identical with SHA-256
`d5c6f235f66d676ff6b8d16d8c407e001d35b147f189e17988a6d91b82aaf065`.

This milestone does not claim lower authoritative server memory. The API still
holds the unchanged matcher result for decisions, exports, and evaluation. The
observed Node heap increased by 202,253,512 bytes and RSS by 301,260,800 bytes
across the measured match request; this is a process observation, not an isolated
retained-size measurement. The prior 825,638,427-byte traced Python peak remains
the applicable matcher evidence because matcher internals did not change.

Run the measurement with `pnpm benchmark:sw012`. Exact data and scope limitations
are in `benchmark-10k.json`.
