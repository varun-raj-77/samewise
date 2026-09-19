# Review-workload analysis: public-review-workload-8k-v1

This deterministic fixture reconstructs the published 8K × 8K workload shape.
Ground truth is held separately and is joined only after truth-blind candidate
generation and scoring. Review yield means **true underlying matches appearing in
review / total review cases**; it is not precision.

## Counts

- Theoretical pairs: 64,000,000
- Candidate pairs: 11,379
- Candidate reduction: 99.982%
- Candidate recall: 100.000%
- Automatic matches: 6,178
- Automatic precision: 100.000%
- False automatic matches: 0
- Review cases: 822
- Review yield: 100.000%
- True top candidates in review: 822
- False top candidates in review: 0
- Truth only in retained alternatives: 0
- No true generated candidate in review: 0
- No match found in B (mutually exclusive product state): 1,000
- No match found in A (mutually exclusive product state): 1,000
- Internal matcher A-only projection: 1,000
- Internal matcher B-not-auto-linked projection: 1,822
- Collisions: 0
- Near ties (margin < 0.04): 0
- Deterministic review groups: 3
- Eligible for human batch SAME: 822
- Eligible for human batch DIFFERENT: 0
- Cases requiring individual review after grouping: 0

## Dominant review signatures

- `persistent_identifier:missing_both:not_applicable|name_or_title:partial_agreement:distinctive|contact_person:exact_agreement:distinctive|email:missing_right:not_applicable|phone:conflict:distinctive|address:exact_agreement:distinctive|geography:exact_agreement:repeated|geography:missing_right:not_applicable|margin:0.10-1.00|alternatives:multiple|collision:false|strong:false`: 795
- `persistent_identifier:missing_both:not_applicable|name_or_title:partial_agreement:distinctive|contact_person:exact_agreement:distinctive|email:missing_right:not_applicable|phone:conflict:distinctive|address:exact_agreement:distinctive|geography:exact_agreement:repeated|geography:missing_right:not_applicable|margin:0.04-0.10|alternatives:multiple|collision:false|strong:false`: 26
- `persistent_identifier:missing_both:not_applicable|name_or_title:partial_agreement:distinctive|contact_person:exact_agreement:distinctive|email:missing_right:not_applicable|phone:conflict:distinctive|address:exact_agreement:distinctive|geography:exact_agreement:repeated|geography:missing_right:not_applicable|margin:0.10-1.00|alternatives:single|collision:false|strong:false`: 1

## Interpretation

The fixture deliberately separates clear overlap, genuine contradictory overlap,
and source-only rows that share repeated supporting attributes. It is useful only
if the resulting queue is close enough to the public walkthrough to expose those
three compositions; its corruption frequencies are not production assumptions.
