# SW-011 benchmark summary

The completed evidence is intentionally bounded to the host and fixtures described
in [the SW-011 performance report](../../../docs/sw-011-performance.md).

| Artifact | Completed scope |
| --- | --- |
| `benchmark-10k.json` | full 8,600 × 8,600 matcher, stage timings, payload, traced Python allocations, subprocess observation, web/export checks |
| `benchmark-50k.json` | 43,000 × 43,000 candidate generation, suppression, candidate recall, traced Python allocations |

The 100K config is committed for reproducibility but was not run. The 50K
candidate-only traced peak and candidate growth made full 50K scoring, 100K, and
250K unsafe or uninformative on this 7.89 GB machine.
