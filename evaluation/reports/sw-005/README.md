# SW-005 candidate benchmark

These are fresh, reproducible measurements for `candidate-engine-v0.1.0` with
`blocking-normalization-v0.1.0`, the committed candidate config, and confirmed
organization mappings. Candidate generation ran before hidden truth was loaded.

| Fixture | A rows | B rows | Theoretical | Candidates | Reduction | True retained | Candidate recall | Runtime | Peak traced Python memory |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| organizations-dev-v1 | 23 | 22 | 506 | 131 | 3.862595x | 21/21 | 100% | 0.053049 s | 619,979 B |
| organizations-candidates-1k-v1 | 870 | 870 | 756,900 | 4,246 | 178.261894x | 738/738 | 100% | 1.642917 s | 16,954,461 B |
| organizations-candidates-10k-v1 | 8,600 | 8,600 | 73,960,000 | 13,283 | 5,568.019273x | 7,164/7,164 | 100% | 22.053859 s | 108,096,256 B |

No true pair was missed, so each retained `misses.json` was empty. The machine
report records exact bucket suppression counts. Runtime is informational and
hardware-dependent. Memory is Python allocation peak measured with `tracemalloc`,
not whole-process resident memory.

The fixtures are synthetic and their normalized website domains are especially
strong evidence. These measurements demonstrate candidate retention on these
fixtures only. They do not establish final record-matching recall, precision,
accuracy, real-data quality, or 100K-row readiness.
