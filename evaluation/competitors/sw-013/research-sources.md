# Research source audit

Research was performed on 2026-09-17. Primary sources are current official
documentation or official repositories. “Confirmed” means documented, not locally
executed.

## Microsoft Power Query

| Claim | Class | Official source |
| --- | --- | --- |
| Exact merge supports one or multiple selected columns. | CONFIRMED | [Merge queries overview](https://learn.microsoft.com/en-us/power-query/merge-queries-overview) |
| Left/right/full outer, inner, and anti joins are available. | CONFIRMED | [Merge queries overview](https://learn.microsoft.com/en-us/power-query/merge-queries-overview) |
| Fuzzy merge is for text columns and uses Jaccard similarity. | CONFIRMED | [Fuzzy merge](https://learn.microsoft.com/en-us/power-query/merge-queries-fuzzy-match) |
| Fuzzy merge supports thresholds, similarity scores, multiple results, case/text-part options, and transformation tables. | CONFIRMED | [Fuzzy merge](https://learn.microsoft.com/en-us/power-query/merge-queries-fuzzy-match) |
| Fuzzy grouping/clustering and similarity output exist. | CONFIRMED | [Table.FuzzyGroup](https://learn.microsoft.com/en-us/powerquery-m/table-fuzzygroup), [Cluster values](https://learn.microsoft.com/en-us/power-query/cluster-values) |
| Applied transformation steps are inspectable and reusable through query references. | CONFIRMED | [Applied steps](https://learn.microsoft.com/en-us/power-query/applied-steps) |
| Power Query lacks a purpose-built evidence/reviewer queue equivalent to Samewise. | NOT VERIFIED | Documentation reviewed did not establish equivalence; absence is not claimed. |

## Data Ladder DataMatch Enterprise

| Claim | Class | Official source |
| --- | --- | --- |
| Multi-source import, profiling, cleansing, standardization, exact/fuzzy/phonetic/numeric matching, configurable weights, and cross-column matching exist. | CONFIRMED | [DataMatch Enterprise](https://dataladder.com/products/datamatch-enterprise/), [Getting started](https://dataladder.com/guide/getting-started-with-datamatch-enterprise/) |
| Results expose groups, pairs, total and column scores, a winning definition, selection for later review, and manual Not Duplicate. | CONFIRMED | [Match results](https://dataladder.com/knowledge-based/match-results/) |
| Master-record selection, conditional field overwrite, survivorship, golden-record creation, and export exist. | CONFIRMED | [Getting started](https://dataladder.com/guide/getting-started-with-datamatch-enterprise/), [Golden record](https://dataladder.com/guide-to-data-survivorship-how-to-build-the-golden-record/) |
| REST API, batch/real-time modes, Docker deployment, current web UI, entity graphs, and match review exist. | CONFIRMED | [API-first platform](https://dataladder.com/datamatch-enterprise-api-first-data-matching-platform/), [DME API](https://dataladder.com/products/datamatch-enterprise-server-api/) |
| Recurring/scheduled cleansing and matching workflows exist. | CONFIRMED | [Getting started](https://dataladder.com/guide/getting-started-with-datamatch-enterprise/) |
| Ten million records completed in 41 minutes. | VENDOR CLAIM | [API-first platform](https://dataladder.com/datamatch-enterprise-api-first-data-matching-platform/) |
| Comparative 99% accuracy and superiority claims. | VENDOR CLAIM | [DataMatch Enterprise](https://dataladder.com/products/datamatch-enterprise/) |
| Exact Samewise-style KEEP BOTH semantics, compatible matcher-regression snapshots, and byte-hashed artifacts exist. | NOT VERIFIED | Current official pages reviewed did not answer these precisely. |

## dedupe Python library

| Claim | Class | Official source |
| --- | --- | --- |
| The current open-source Python library performs deduplication and record linkage. | CONFIRMED | [dedupe GitHub repository](https://github.com/dedupeio/dedupe) |
| `RecordLink` links two datasets; learned fingerprints generate candidates; scored links support one-to-one and many-to-one constraints. | CONFIRMED | [Library API](https://docs.dedupe.io/en/latest/API-documentation.html) |
| Humans provide match/distinct labels and active learning selects uncertain pairs while relearning weights and blocking. | CONFIRMED | [Matching records](https://docs.dedupe.io/en/latest/how-it-works/Matching-records.html) |
| Duplicate likelihoods and precision/recall-informed threshold selection are supported. | CONFIRMED | [Choosing a threshold](https://docs.dedupe.io/en/latest/how-it-works/Choosing-a-good-threshold.html) |
| The library ships a full reconciliation review/survivorship product. | NOT VERIFIED | The API says uncertain-pair methods are useful for building a UI; no current library product surface was established. |
| The historical dedupe.io hosted service closed on 2023-01-31. | CONFIRMED | [dedupe.io FAQ](https://dedupe.io/documentation/faq.html) |

## Splink

| Claim | Class | Official source |
| --- | --- | --- |
| Splink implements probabilistic linkage with Fellegi-Sunter match weights and estimated parameters. | CONFIRMED | [Parameter estimation](https://moj-analytical-services.github.io/splink/demos/tutorials/04_Estimating_model_parameters.html), [Model evaluation](https://moj-analytical-services.github.io/splink/topic_guides/evaluation/model.html) |
| Blocking is configurable and analyzable as a runtime/recall tradeoff. | CONFIRMED | [Blocking tutorial](https://moj-analytical-services.github.io/splink/demos/tutorials/03_Blocking.html) |
| Label-based precision, recall, error inspection, ROC, and threshold selection are supported. | CONFIRMED | [Evaluation API](https://moj-analytical-services.github.io/splink/api_docs/evaluation.html) |
| Waterfall, comparison-viewer, cluster, parameter, and match-weight dashboards exist. | CONFIRMED | [Charts gallery](https://moj-analytical-services.github.io/splink/charts/) |
| DuckDB, Spark, Athena, SQLite, and PostgreSQL backends are documented. | CONFIRMED | [Backends](https://moj-analytical-services.github.io/splink/topic_guides/splink_fundamentals/backends/backends.html) |
| Splink ships a transaction-style reviewer queue with defer/undo and a survivorship workbench. | NOT VERIFIED | Diagnostic/spot-checking dashboards are documented; exact workflow equivalence was not established. |

## Secondary context

- [AWS Entity Resolution](https://docs.aws.amazon.com/entityresolution/latest/userguide/what-is-service.html): CONFIRMED managed rule, ML, and provider workflows with normalization, confidence, encryption, and S3 outputs.
- [Zingg find and label](https://docs.zingg.ai/latest/stepbystep/createtrainingdata/findandlabel): CONFIRMED active labeling; its current docs also cover deterministic/probabilistic matching, custom blocking, and model documentation.
- [Reltio merge behavior](https://docs.reltio.com/en/objectives/resolve-potential-matches/potential-matching-at-a-glance/potential-matching-reference/merge-matched-data): CONFIRMED mature merge/unmerge, crosswalk, relationship, and retained-history behavior.
- [Informatica survivorship](https://docs.informatica.com/master-data-management/multidomain-mdm/10-4/configuration-guide/part-4--configuring-the-data-flow/mdm-hub-processes/about-informatica-mdm-hub-processes/rowid_object-survivorship.html): CONFIRMED mature MDM survivorship behavior.
