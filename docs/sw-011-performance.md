# SW-011 scale and performance evidence

SW-011 measured the existing synchronous, process-local pipeline before changing
it. The implementation changes are deliberately narrow: reuse blocker preparation,
avoid repeated key normalization, cache normalized scoring values once per row and
mapping, and add a machine-readable stage benchmark. Candidate membership, feature
definitions, weights, thresholds, and matcher/candidate versions are unchanged.

## Environment and method

- Windows 11 Home Single Language 10.0.26200, 64-bit
- AMD Ryzen 5 5600H, 6 cores / 12 logical processors
- 7,887,228,928 bytes physical memory
- CPython 3.13.15, Node 24.19.0, pnpm 11.19.0
- candidate engine `candidate-engine-v0.2.0`
- blocking normalization `blocking-normalization-v0.1.0`
- feature pipeline `feature-pipeline-v0.1.0`
- matcher `explainable-matcher-v0.2.0`

Normal wall runs do not enable tracing. Separate memory runs use Python
`tracemalloc`; their peaks are traced Python allocations, not process RSS, native
allocations, or host memory. Tracing materially increases runtime, so traced time is
not compared with normal wall time. Source CSVs are generated beneath ignored
`.samewise-data` paths and remain unchanged.

The normal pipeline measured by `samewise-matcher performance benchmark` is:

1. CSV input load using the product parser.
2. Exact profiling over already loaded rows.
3. blocking normalization and inverted-index construction.
4. candidate union, suppression, deduplication, evidence, and candidate assembly.
5. one normalized scoring representation per row and identity mapping.
6. feature extraction over emitted candidates.
7. score aggregation.
8. deterministic ranking and result assembly.
9. Pydantic JSON serialization at the Python/API boundary.

Truth is opened only after visible candidate generation and scoring. Candidate
recall remains an evaluation-only ceiling and is never described as matcher recall.

## Fixtures

The 10K run reuses `organizations-candidates-10k-v1` (seed 5002). The 50K run
uses `organizations-performance-50k-v1` (seed 11011) with the same moderate
corruption probabilities, 70/15/15 overlap/source-only distribution, 500 duplicate
rows per side, and three hard-negative pairs. Both include missing and corrupted
identifiers, name/address/location variation, source-only rows, duplicates, schema
differences, and plausible hard negatives. Generated datasets are not committed.

The checked-in 100K config uses seed 11012 and the same distribution. It was not
generated or run after the 50K candidate phase established that escalation was not
safe or useful on this host.

## Measured results

| Scope | A × B rows | Theoretical pairs | Candidates | Reduction | Candidate recall | Normal wall | Traced Python peak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10K full matcher | 8,600 × 8,600 | 73,960,000 | 13,801 | 5,359.031954× | 7,164 / 7,164 (100%) | 18.378080 s including serialization | 825,638,427 B |
| 50K candidate phase | 43,000 × 43,000 | 1,849,000,000 | 366,207 | 5,049.056954× | 35,837 / 35,837 (100%) | 28.395842 s generation | 1,103,961,077 B |

The theoretical pair counts are integer products only; neither run materialized an
all-pairs matrix. The 50K traced peak covers candidate generation only. Full 50K
feature/scoring/result serialization was not attempted because it would retain
evidence for 366,207 candidates after a candidate-only traced peak of 1.10 GB.

### 10K normal stage breakdown

| Stage | Seconds |
| --- | ---: |
| fixture/input load | 0.169376 |
| exact profiling | 0.145973 |
| normalization/index construction | 2.136776 |
| candidate generation/assembly | 1.372737 |
| feature normalization cache | 0.717731 |
| feature extraction | 11.249975 |
| scoring | 1.861251 |
| result assembly/ranking | 0.273165 |
| API-relevant JSON serialization | 0.651487 |
| matcher through serialization | 18.378080 |
| evaluation-only recall join | 0.060069 |

The serialized product result is 56,892,493 UTF-8 bytes for 7,663 retained product
candidates, 1,244 A-only rows, and 2,378 B-only rows. This is the clearest product
scale limit: the current API returns the complete result/evidence object even though
the review queue mounts only a small window.

## Profile evidence and optimizations

Pre-change `cProfile` on the 10K candidate benchmark recorded 13,063,057 calls in
52.284 seconds under profiling/tracing. `generate_candidates` accounted for 49.769
seconds, `_inverted_indices` 40.054 seconds, and `record_blocking_keys` 36.518
seconds. Repeated compact-name construction, normalization, mapping-kind lookup,
and stop-token set creation were visible hot paths.

The pre-change full matcher profile recorded 52,194,234 calls in 63.793 seconds.
Visible candidate scoring accounted for 31.954 seconds; 110,408 field-evidence
computations accounted for 29.301 seconds; field strengths accounted for 19.459
seconds; and `difflib` ratio work accounted for 15.602 seconds. Candidate generation
accounted for 10.926 seconds. The evaluation-only legacy baseline scorer accounted
for another 16.635 seconds and is not part of the product matcher.

The implementation now prepares mapping kinds and stop tokens once per generation,
normalizes each email once while forming strong keys, computes compact names once
per row/name, and caches each normalized scoring value once per row/mapping. No
candidate, feature, or score semantics changed.

Using the same 10K fixture and traced candidate command, generation changed from
21.819351 seconds and 132,965,984 peak traced bytes to 16.828664 seconds and
132,967,200 peak traced bytes: 22.9% less traced wall time with effectively flat
traced allocation peak. The same full evaluation command changed from 33.68 to
30.35 seconds (9.9% faster). Candidate count and recall remained 13,801 and
7,164/7,164.

## Suppression and stress evidence

At 50K, the blocker suppressed 1,109,750,711 relationships across 1,392 keys while
still retaining every known true pair. `name_character_v1` produced 293,422 raw
relationships that contributed to 293,297 candidates and was the main candidate
growth source. Suppression was not loosened: the same limits prevented more than a
billion relationships from entering candidate materialization.

Focused tests cover oversized common buckets, empty values, duplicate-heavy strong
identifiers, long Unicode names, and deterministic candidate ordering. The combined
long-Unicode/common/null case suppresses three 25×25 buckets (1,875 relationships)
and emits no candidates. Existing weak-identifier evidence still records the known
suppression-related misses; SW-011 does not hide or reinterpret them.

## API, web, profile, and export observations

A fresh Python process around the 10K product match took 22.849003 seconds and
transferred 56,892,493 stdout bytes. The internal measured matcher plus JSON
serialization was 18.378080 seconds, leaving an observed 4.470923-second difference
for interpreter startup, request handling, pipe transfer, and the external capture.
This run did not include Node contract validation, so it is not labeled total
Fastify overhead. Subprocess orchestration is measurable but is not the dominant
hot path and was retained.

Profiling is exact and deterministic. It does not sample, and the benchmark reuses
the exact product statistics. The product upload path still invokes one profile
subprocess per source and the later match subprocess reparses each immutable CSV.
At 10K, load plus exact profile is 0.315349 seconds in-process, so reparsing is not
the current bottleneck. The committed 2 MiB upload limit admits the 10K source files
(1,817,970 and 1,739,170 bytes) but not the 50K files (9,241,357 and 8,856,743 bytes).

The review queue test still supplies 10,000 items while mounting fewer than 30
rows. Results retain at most three alternatives per A row. Evaluation errors remain
paged and progressively disclosed. However, the browser still receives the whole
run result, including all retained candidate evidence and source-only records; the
56.9 MB 10K response makes server-side paging/projection a future product concern.

The opt-in export benchmark uses finalized source-only RunViews, independently of
matcher completion. At 10,000 rows, reconciliation CSV generation took 228.326 ms,
trusted CSV generation 107.848 ms, and a complete snapshot that regenerated both
CSVs and hashed them into the manifest took 331.672 ms. At 50,000 rows the same
measurements were 798.726 ms, 391.974 ms, and 1,196.249 ms. Repeated snapshots were
equal. Export remains small relative to matching, so no streaming or format change
was added. These source-only shapes do not measure conflict-heavy finalized runs.

## Quality and version gates

Candidate membership and scoring equivalence have focused tests. Development,
weak-identifier, and held-out evaluation gates are rerun during closeout. No weights,
thresholds, blocking keys, bucket limits, feature definitions, or result ordering
changed. Therefore matcher, feature-pipeline, candidate-engine, and normalization
versions remain unchanged; `sw-011-normalization-cache-v1` identifies only the
performance implementation revision.

## Measured, estimated, and not tested

Measured: the 10K full pipeline, 10K traced allocation peak, 10K fresh-process
boundary, 10K bounded DOM, 10K/50K source-only finalized export generation/hashing,
and 50K candidate generation/recall/traced allocation peak.

Estimated only: applying the observed per-candidate feature cost to 366,207 50K
candidates suggests several minutes of scoring, and scaling the current complete
result payload suggests hundreds of megabytes. These projections are not benchmark
results and are not used as capacity claims.

Not tested: full 50K scoring/serialization, 100K, 250K, million-row behavior,
whole-process RSS, concurrent requests, or deployed-host limits.

## Deployment and SW-012 decision

Public deployment still has process-local run/decision state, local filesystem
artifacts, a required Python subprocess, a 2 MiB upload limit, long synchronous
requests near the admitted 10K boundary, and an oversized complete-result response.
A host must have materially more headroom than the 825.6 MB traced Python-allocation
peak; that number is not an RSS requirement.

Measured evidence does **not** justify implementing a queue, Redis, worker, or
persistent Python service in SW-012. Async infrastructure would not reduce feature
cost, candidate growth, evidence retention, or the 56.9 MB response. The next
reliability decision should first bound the API result projection/paging and reduce
in-process scoring retention while preserving evidence and deterministic semantics.
Durable run state may still be justified by product reliability requirements, but
SW-011 performance measurements alone do not justify it.

Machine-readable summaries are in `evaluation/benchmarks/sw-011/`.
