# Review-workload analysis: public-review-workload-8k-v1

This deterministic fixture reconstructs the published 8K × 8K workload shape.
Ground truth is held separately and is joined only after truth-blind candidate
generation and scoring. Review yield means **true underlying matches appearing in
review / total review cases**; it is not precision.

## Counts

- Theoretical pairs: 64,000,000
- Candidate pairs: 12,366
- Candidate reduction: 99.981%
- Candidate recall: 100.000%
- Automatic matches: 6,178
- Automatic precision: 100.000%
- False automatic matches: 0
- Review cases: 1,312
- Review yield: 62.652%
- True top candidates in review: 822
- False top candidates in review: 490
- Truth only in retained alternatives: 0
- No true generated candidate in review: 490
- No match found in B (mutually exclusive product state): 510
- No match found in A (mutually exclusive product state): 510
- Internal matcher A-only projection: 510
- Internal matcher B-not-auto-linked projection: 1,822
- Collisions: 0
- Near ties (margin < 0.04): 0
- Deterministic review groups: 3
- Eligible for human batch SAME: 0
- Eligible for human batch DIFFERENT: 0
- Cases requiring individual review after grouping: 1,312

## Dominant review signatures

- `other:missing_both:not_applicable|name:partial_agreement:distinctive|name:exact_agreement:distinctive|email:missing_right:not_applicable|phone:conflict:distinctive|address:exact_agreement:distinctive|city:exact_agreement:repeated|postal:missing_right:not_applicable|margin:0.10-1.00|alternatives:multiple|collision:false|strong:true`: 821
- `other:partial_agreement:distinctive|name:conflict:distinctive|name:exact_agreement:repeated|email:conflict:distinctive|phone:conflict:distinctive|address:conflict:distinctive|city:exact_agreement:repeated|postal:exact_agreement:distinctive|margin:0.04-0.10|alternatives:multiple|collision:false|strong:true`: 490
- `other:missing_both:not_applicable|name:partial_agreement:distinctive|name:exact_agreement:distinctive|email:missing_right:not_applicable|phone:conflict:distinctive|address:exact_agreement:distinctive|city:exact_agreement:repeated|postal:missing_right:not_applicable|margin:0.10-1.00|alternatives:single|collision:false|strong:true`: 1

## Interpretation

The fixture deliberately separates clear overlap, genuine contradictory overlap,
and source-only rows that share repeated supporting attributes. It is useful only
if the resulting queue is close enough to the public walkthrough to expose those
three compositions; its corruption frequencies are not production assumptions.
