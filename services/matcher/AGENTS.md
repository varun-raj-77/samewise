# Matcher-specific constraints

- Product candidate generation may read visible A/B rows, confirmed mappings, and
  explicit candidate config only. Hidden fixture truth and provenance belong in
  `candidate_evaluation.py` or other evaluation-only modules.
- Keep the all-pairs scorer as a small-fixture oracle. Never use it for large
  benchmark fixtures.
- Any change that alters blocking normalization, keys, bucket policy, candidate
  identity/order, or blocker provenance requires comparison against the committed
  development snapshot, weak-identifier falsification snapshot, and fresh 1K/10K
  candidate benchmarks.
- Candidate recall is a gating metric. Do not merge a blocker change that lowers
  it without an explicit, reviewed tradeoff supported by miss diagnostics.
- Do not label candidate recall as final record-matching recall or report scoring
  precision/accuracy from the candidate evaluator.
