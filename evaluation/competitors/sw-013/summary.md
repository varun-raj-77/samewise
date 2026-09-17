# SW-013 adversarial validation summary

## Executive conclusion

Samewise deserves to exist as a portfolio flagship and as a narrow hypothesis for
real-user testing. The broad commercial thesis does not survive intact.

Power Query is the better answer for stable-key joins, deterministic normalized
joins, and many simple fuzzy-text merges. DataMatch Enterprise already covers most
of the end-to-end commercial workbench: profiling, cleansing, composite matching,
review, manual non-duplicate decisions, survivorship, golden records, export, API,
Docker deployment, entity graphs, and scheduling. dedupe and Splink are stronger
algorithmic references; Splink is also stronger in statistical evaluation depth.

The remaining Samewise wedge is a deliberately narrow two-file experience for
high-risk, one-time reconciliation where a reviewer needs field-level evidence,
explicit unresolved state, collision visibility, a hard separation between identity
and value selection, deterministic artifacts, and a version-compatible evaluation
story. That wedge is not proven demand. It warrants interviews and observed-task
testing, not another engineering milestone.

**Commercial verdict: COMMERCIAL THESIS NARROWED.**

**Portfolio verdict: PORTFOLIO FLAGSHIP VALIDATED.**

**Milestone verdict: SW-013 PASS — READY FOR DEPLOYMENT AND FINAL PACKAGING.**

“Deployment” here means the SW-013 validation milestone is complete enough to move
to the already-planned packaging decision. It is not a production-readiness claim;
the current product still lacks authentication, persistence, durable jobs, and a
validated security/deployment model.

## Methodology

The comparison used ten deterministic, human-readable scenarios. Samewise was run
twice with the production candidate engine and frozen matcher. Inputs were checked
for truth-like columns; labels remained under separate `truth/` directories.
Executed results record auto matches, review cases, false auto matches, candidate
misses, candidate recall, decisions required, visible evidence fields, collisions,
post-identity field conflicts, alternatives, source-only rows, and output hashes.

Competitors were not installed or run. Current official documentation was reviewed
for Microsoft Power Query, DataMatch Enterprise, dedupe, Splink, AWS Entity
Resolution, Zingg, Reltio, and Informatica. Every competitor conclusion is marked
DOCUMENTED CAPABILITY or NOT VERIFIED. Data Ladder performance/accuracy statements
remain VENDOR CLAIMS.

## Important corrections

1. Power Query is not “one-value exact matching.” It supports multi-column exact
   merges, all major outer/anti join forms, fuzzy merge, thresholds, multiple
   returned matches, similarity scores, transformation tables, fuzzy grouping, and
   repeatable applied steps.
2. DataMatch Enterprise is not fairly described as legacy desktop software. Current
   official material documents a web application, REST API, Docker deployment,
   entity graphs, match review, real-time/batch operation, and scheduling.
3. DataMatch owns or equals much of Samewise's conceptual workflow. Samewise has no
   advantage in connectors, data preparation breadth, matching-method breadth,
   golden-record capability, production deployment, or recurring jobs.
4. The hosted dedupe.io service ended on 2023-01-31. The open-source dedupe Python
   library remains the relevant active comparator.
5. Samewise does not have dedupe's active learning or Splink's statistical rigor,
   calibration/evaluation breadth, or large-backend options.
6. Samewise surfaces collisions but does not solve global assignment.
7. Samewise survivorship applies only to comparison-role mappings. In S07, address
   and phone are identity evidence, so their raw disagreement is visible but they do
   not become survivorship-controlled conflicts. This is a real scope limitation,
   not a reason to add a feature during SW-013.

## Scenario verdicts

| Scenario | Samewise executed observation | Product-thesis result |
| --- | --- | --- |
| S01 exact join | Two automatic links, zero reviews/misses/false autos | RED — use Power Query/SQL |
| S02 normalized join | One automatic link, zero reviews/misses/false autos | RED — use transforms + join |
| S03 simple fuzzy | One automatic link, zero reviews/misses/false autos | RED/YELLOW — Power Query likely sufficient |
| S04 contradictory evidence | Review route, eight evidence fields, two alternatives | GREEN versus a single-score merge; DataMatch remains serious |
| S05 near tie | Two retained candidates; contradiction forces review after fixture correction | GREEN for decision support, not a unique-market claim |
| S06 collision | Both A rows route to review with collision flags | GREEN for visibility; no global-assignment claim |
| S07 identity/survivorship | Review plus raw address/phone/contact/date conflicts; only comparison-role fields enter survivorship | YELLOW — DataMatch is stronger overall |
| S08 regression | Frozen exact/fuzzy set reproduces without candidate misses | YELLOW/GREEN — Samewise has a cohesive artifact; Splink is statistically stronger |
| S09 provenance | Deterministic matcher hash plus existing product manifest semantics | YELLOW/GREEN; DataMatch equivalence is not verified |
| S10 reviewer throughput | Mixed auto/review queue with collision context and field evidence | INCONCLUSIVE versus DataMatch without hands-on testing |

The exact current counts and SHA-256 output identities live in
`scenario-results.json`; this prose does not replace the machine artifact.

## Power Query boundary

Use Power Query when an exact key, deterministic normalized keys, or a straightforward
fuzzy-text merge solves the problem and reviewers do not need a purpose-built queue
or a portable evidence package. Power Query remains attractive because it is
ubiquitous, refreshable, inspectable, and competent.

Samewise begins to add incremental value when plausible candidates trade off
different fields, strong identifiers contradict, multiple A records target one B
record, unresolved decisions must remain explicit, identity must be separated from
survivorship, or another person must reconstruct inputs, versions, human decisions,
policy, and output bytes. This boundary is documentary until the supplied Power
Query reproduction package is actually run.

## DataMatch Enterprise finding

The supported conclusion is closest to option B: DataMatch is broader and more
mature; Samewise has only a narrower review/evaluation/audit wedge. DataMatch has
documented conceptual parity or superiority in profiling, normalization, matching
methods, review, survivorship, golden records, export, API, deployment, connectors,
scale, and recurring work. Samewise's clearest narrow advantages are checked-in
version-compatible evaluation artifacts and deterministic artifact hashing, but
equivalent DataMatch internals were not available for hands-on verification.

No “unique reviewer workflow” claim is supported. A DataMatch trial with the same
S04–S10 inputs would be required before claiming better review throughput or audit
ergonomics.

## dedupe and Splink findings

dedupe is the stronger reference for active learning: human match/distinct labels
drive learned weights and blocking, `RecordLink` supports two datasets, and its
link constraints can address assignment semantics that Samewise does not.
Integrators must build the broader reconciliation UI and survivorship workflow.

Splink is the stronger reference for probabilistic rigor, parameter estimation,
calibrated/statistical match weights, labeled error analysis, ROC/precision-recall
threshold tools, diagnostic dashboards, and larger SQL backends. Samewise's value
relative to Splink is product workflow around uncertainty, not a better linkage
model.

## Secondary competitors

AWS Entity Resolution provides managed rule/ML/provider matching and cloud security
controls. Zingg provides active labeling, learned matching, custom blocking, and
enterprise explanations. Reltio and Informatica show the depth of mature MDM merge,
unmerge, crosswalk, trust, survivorship, and audit behavior. Samewise should not
position as a replacement for these platforms.

## Identity, survivorship, review, and reproducibility

Samewise's conceptual separation between “same entity?” and “which value survives?”
is sound, but it is not unique: DataMatch documents a mature merge/survivorship
module and MDM products go much further. Samewise is strongest when the separation
is explained through a focused workflow and explicit unresolved/trusted-output
gates. Its mapping-role restriction weakens the current implementation.

The Samewise review surface is credible portfolio work: ranked alternatives,
field-level evidence, keyboard actions, defer, undo, collision context, progress,
and survivorship handoff are implemented. DataMatch documents material overlap, so
comparative throughput remains inconclusive until both are observed on the same
task.

Samewise's strongest defensible engineering story is reproducibility: frozen
versions, candidate recall as a gate, explicit error categories, compatible snapshot
comparison, deterministic manifests, and exact artifact hashes. Splink is stronger
in statistical evaluation; Samewise is stronger only in binding evaluation and
human workflow into one small product.

## Scale

Samewise has complete local evidence at 10K and candidate-only evidence at 50K. It
must not claim million-scale operation. Splink documents backends suited to millions
and larger workloads. DataMatch reports a 10M-record run, but that remains a vendor
claim here. Power Query scale depends heavily on host, source, query folding, and
model shape; no SW-013 benchmark was executed.

## Target-user fit

| Workflow | Fit | Reason |
| --- | --- | --- |
| M&A data integration | HIGH | One-time, risky joins; multiple systems; audit and human judgment matter. |
| CRM migration | HIGH | PII, duplicate customers, conflicting contact values, and irreversible merge risk. |
| ERP/legacy migration | MEDIUM | Strong pain and risk, but connectors, deployment, and broader transformation are currently missing. |
| Vendor/customer consolidation | HIGH | Multi-field ambiguity and field conflicts fit the workflow. |
| RevOps cleanup | MEDIUM | Frequent need, but Power Query and DataMatch may be sufficient and budgets vary. |
| Consultants/data-migration specialists | HIGH | Repeated one-time projects and a need to hand clients an evidence package. |
| Nonprofit migrations | MEDIUM | Real risk and messy files, but low budgets and privacy capacity constrain adoption. |

No market-size, revenue, accuracy, or conversion estimate is made.

## Privacy and deployment

The best-fit cases commonly contain customer/vendor PII, financial context, and
sometimes regulated information. Reluctance to upload that data materially weakens
a public SaaS-only direction. Samewise's current process-local development setup is
not a security answer.

Local desktop or local-first packaging is therefore a plausible future direction,
especially for consultants and migrations inside controlled environments. It must
be validated with users and security stakeholders before implementation. SW-013
does not add Electron/Tauri, authentication, persistence, or deployment machinery.

## Recommended positioning

**Human review and audit layer for high-risk, one-time file reconciliation during
migrations and consolidations.**

This is narrower than “entity resolution platform” and more honest than competing
with DataMatch or MDM. It leaves room for Samewise to accept deterministic or other
matcher evidence in the future, but no such integration should be built before
target users demonstrate that review/audit pain is unsolved by current tools.

## Safe claims

- Built an explainable, human-in-the-loop two-file reconciliation workflow.
- Separated identity decisions from deterministic survivorship decisions.
- Implemented truth-blind candidate generation, candidate-recall gates, frozen
  evaluation snapshots, and deterministic provenance artifacts.
- Compared the workflow adversarially with Power Query, DataMatch, dedupe, and
  Splink and documented where simpler or more mature tools are preferable.
- On the committed SW-013 fixtures, Samewise produced deterministic outputs with no
  false automatic links and no candidate misses. These are fixture facts only.
- Designed reviewer interactions for alternatives, contradiction, collision,
  defer, undo, keyboard flow, and unresolved-state gating.

## Do not say

- Better than Power Query, DataMatch, Splink, dedupe, or enterprise MDM.
- First or unique AI/entity-resolution/reviewer product.
- Statistically rigorous or probabilistically calibrated.
- One hundred percent accurate.
- Scales to millions.
- Production-ready, enterprise-secure, or compliant.
- DataMatch lacks human review, survivorship, web/API deployment, or auditability.
- Power Query cannot fuzzy match, return multiple candidates, or show similarity.
- dedupe.io is a current hosted SaaS.
- Samewise solves global assignment or golden-record MDM.

## Known limitations and next action

The scenario set is tiny and intentionally diagnostic, not a benchmark of external
accuracy. Only Samewise was executed. Power Query and DataMatch hands-on ergonomics
remain the biggest evidence gaps. Samewise results use synthetic organization data,
uncalibrated scores, process-local state, and a mapping model that prevents
survivorship rules from governing identity-role fields.

The next action is not engineering. Conduct five to eight observed sessions with
data-migration consultants or CRM/M&A migration leads. Give them S04–S10 or safely
redacted real cases and compare their current workflow, Power Query, and—where
available—DataMatch. Measure time per decision, errors corrected, evidence needed,
handoff/audit requirements, privacy constraints, and willingness to adopt a local
or controlled-deployment review layer. If that evidence does not reveal an unmet
workflow gap, keep Samewise as a portfolio demonstration and stop product work.
