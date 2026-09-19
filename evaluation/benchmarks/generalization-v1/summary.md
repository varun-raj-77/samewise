# Multi-domain generalization suite

Suite: `generalization-suite-v1.0.0`  
Matcher: `explainable-matcher-v0.3.0`  
Candidate engine: `candidate-engine-v0.4.0`  
Threshold changes: **none**

| Fixture | Candidate recall | Reduction | Auto precision | Recall | False auto | Review rate | Review yield | Collisions |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| organizations_vendors | 100.000% | 97.551% | 100.000% | 100.000% | 0 | 2.857% | 100.000% | 0 |
| people_customers | 100.000% | 97.551% | 100.000% | 100.000% | 0 | 2.857% | 100.000% | 0 |
| products | 100.000% | 71.347% | 100.000% | 100.000% | 0 | 0.000% | n/a | 0 |
| facilities | 100.000% | 90.776% | 100.000% | 100.000% | 0 | 11.429% | 50.000% | 4 |
| sparse_legacy | 100.000% | 87.347% | 100.000% | 93.333% | 0 | 51.429% | 61.111% | 10 |
| low_information | 100.000% | 75.510% | n/a | 10.000% | 0 | 85.714% | 10.000% | 30 |

Low-information success means abstention, not matching everything.
Overall gate: **PASS**
