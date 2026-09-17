# SW-012 bounded result projection and on-demand evidence

SW-012 changes data delivery, not matching. Candidate membership, ranks, scores,
features, bands, identity decisions, survivorship, evaluation, and export semantics
remain unchanged. The API continues to retain the authoritative matcher result in
process, but the browser receives explicit bounded projections and asks for a full
candidate explanation only when a reviewer selects it.

## Baseline diagnosis

The SW-011 10K fixture was rerun before projection work. Its unchanged Python
`MatcherResult` serialized to exactly 56,892,493 UTF-8 bytes with SHA-256
`8115ff85dcda59d68797bcd84894454dade77007e2357329bf303de969a91ba8`.
It contained 7,663 retained candidates for 7,356 A rows, 307 alternatives beyond
rank one, 1,244 A-only rows, and 2,378 B-only rows.

The 54,786,827-byte candidate array dominated the payload. Within overlapping
measurements, evidence/features accounted for about 40,831,625 bytes, blocking
evidence for 5,612,358 bytes, repeated candidate record snapshots for 5,834,812
bytes, and candidate metadata for 2,086,566 bytes. A-only and B-only records added
493,053 and 1,012,007 bytes. These categories overlap and are diagnostic rather
than an additive byte ledger.

The former path was:

```text
Python MatcherResult -> subprocess stdout -> JSON.parse/Zod -> WorkflowStore
-> derived complete RunView -> every run/mutation response -> browser
```

This duplicated evidence on the wire even when a screen needed only counts or one
visible page. DOM virtualization did not address that transfer.

## Projection boundary

`WorkflowStore` still owns the authoritative `MatcherResult`, decisions, conflicts,
deferred state, undo history, and policy state. Export and human-evaluation evidence
continue to derive from the complete authoritative `RunView`; neither depends on a
page the browser happened to load.

The HTTP boundary now uses projection contract version `1.0.0`:

- `RunSummary` contains workflow state, source profiles/fingerprints, confirmed
  mappings, matcher provenance, counts, review progress, conflict counts, undo
  availability, policy state, and trusted-export readiness. It contains no
  candidate, evidence, review-queue, decision, conflict, or source-only arrays.
- `ResultsPage` contains compact identity fields, status, top-candidate summary,
  alternative count, decision summary, and collision state.
- `ReviewQueuePage` contains queue-scanning evidence summaries, compact alternatives,
  decision/defer state, collision/contradiction flags, and progress.
- `CandidateEvidenceDetail` returns the exact retained candidate: both visible source
  records, blocker provenance, all features/evidence, score, rank, band,
  contradiction and collision context, alternatives, relevant conflicts, human
  decision, matcher version, and candidate-engine version.
- `ConflictPage` contains the effective-link conflicts needed by survivorship.

The candidate detail is not reconstructed. It is selected from authoritative state,
so its candidate object is value-equal to the original matcher candidate. Focused
tests compare the complete object and provenance. This avoids a second explanation
implementation and preserves reproducibility.

## Paging semantics

Results, review, and conflicts use simple offset paging because state is currently
process-local arrays. The default is 50 items and the server-enforced maximum is
100. Invalid or negative offsets and non-positive limits are rejected; larger
limits are clamped to 100.

- Results order: ascending stable A row ID, with source order retained in each item.
- Review order: the requested explicit sort (`ambiguity`, score, candidate count,
  or source order) plus stable source-order tie breaking. Filters and search run on
  the server before paging.
- Conflicts order: ascending conflict ID.

Fetching detail never changes list order. Decisions, defer changes, undo, and
resolutions update authoritative state and return a fresh compact `RunSummary`;
the relevant page is then reloaded. Undo can return an item to its deterministic
position without creating a duplicate. Existing protections still block undo when
a dependent conflict has been resolved.

## Browser behavior

Results loads 50 compact rows at a time. Review loads a 50-item queue page and
fetches the selected candidate detail separately. Selection clears prior detail
before loading, shows a restrained loading state, and offers retry on failure. A
bounded ten-entry detail cache avoids repeated nearby requests without introducing
a caching library. Candidate-rank selection fetches evidence but never records a
decision. Existing S/D/E/U and J/K/arrow keyboard behavior, side-by-side records,
feature disclosure, collisions, progress, and virtualized mounting remain intact.

Survivorship likewise loads a bounded conflict page. Evaluation's immutable
snapshot/error paging is unchanged; human review evidence uses the authoritative
internal view rather than browser projections.

## 10K measured result

The normal upload/profile/mapping/match path was exercised through Fastify and the
real Python subprocess. Exact response sizes were:

| Response | Bytes | Reduction vs 56,892,493 B baseline |
| --- | ---: | ---: |
| Match `RunSummary` | 8,386 | 99.985260% |
| GET `RunSummary` | 8,385 | 99.985262% |
| Results page, 50 real rows | 49,263 | 99.913410% |
| Review page, 50 real cases | 88,351 | 99.844705% |
| Conflict page, 50 real conflicts | 23,545 | 99.958615% |
| Selected candidate full evidence | 7,468 | 99.986873% |

The largest observed ordinary initial browser payload was the 88,351-byte review
page, 643.94 times smaller than the baseline matcher result. The synchronous match
request took 24.656 seconds on the documented SW-011 host. First-page requests took
58–279 ms and the first evidence detail took 94 ms. These are local fixture/machine
observations, not public SLAs.

The sanity run exercised run creation, both uploads, mappings, Results/Review/
conflict paging, alternative-rank inspection, SAME, DIFFERENT, undo, defer/restore,
field resolution/clear, human evaluation evidence, reconciliation export, manifest,
repeated bytes, and manifest hash agreement. The repeated 9,819,677-byte export was
identical with SHA-256
`d5c6f235f66d676ff6b8d16d8c407e001d35b147f189e17988a6d91b82aaf065`.
The manifest was 6,356 bytes and repeated byte-for-byte.

Machine-readable evidence is in `evaluation/benchmarks/sw-012/`; rerun it with
`pnpm benchmark:sw012` after generating the documented 10K fixture.

## Memory and remaining bottleneck

Payload reduction and server retention are separate. SW-012 deliberately does not
rewrite the authoritative result. The measured Node process moved from 39,550,296
to 241,803,808 heap-used bytes (a 202,253,512-byte increase) and from 127,750,144
to 429,010,944 RSS bytes across the match request. This includes parsing, retained
state, and response construction and is not an isolated object-size measurement.
The prior 825,638,427-byte `tracemalloc` peak remains the Python evidence because
matcher internals are unchanged; it is not RSS.

Repeated source snapshots and evidence remain candidates for future measured
normalization, but changing them now would complicate exact evidence and export
semantics. The current milestone therefore solves the browser-transfer problem and
honestly leaves authoritative memory as the principal scale limit.

## Security, persistence, and deployment

Detail lookup accepts only a run-owned candidate ID and never accepts a path. Tests
reject missing/wrong-run candidates and scan ordinary responses for hidden truth,
corruption provenance, paths, keys, and prompt material. Compact identity fields
derive only from confirmed identity mappings. Source files remain immutable.

Pagination is not persistence. All run/result/decision state is still lost on API
restart, uploads still use local ignored files, matching still requires synchronous
Python, and there is no authentication, rate limiting, durable storage, or
concurrency control. Redis, queues, workers, and a database would not reduce the
measured evidence object or improve current deterministic semantics, so none were
added.

For a public portfolio deployment limited to constrained demo datasets and a
single-process lifecycle, browser delivery is now reasonable. It is not ready for
untrusted public multi-user workloads or large customer datasets. Before expanding
scale, measure and safely normalize authoritative retention, then reassess durable
state and operational controls from actual deployment requirements.
