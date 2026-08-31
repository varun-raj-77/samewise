# Samewise engineering constraints

Samewise takes two messy datasets, determines which records refer to the same real-world entity, asks humans about uncertain cases, and produces a trusted reconciled result.

These constraints are permanent unless a documented architecture decision changes them:

- Power Query is the adversarial baseline. Samewise must not become a fuzzy spreadsheet merge utility.
- Source datasets are immutable.
- Identity is not survivorship: deciding whether records refer to the same entity is separate from deciding which conflicting value wins.
- Use algorithms for scalable matching and AI only for semantic ambiguity.
- Never accept unvalidated free-form AI output as a process contract.
- Matcher behavior must be explainable, versioned, and reproducible.
- Matcher changes will require benchmark comparison once the evaluation harness exists.
- Candidate recall is a gating metric.
- Never fabricate metrics, benchmark results, or matcher evidence.
- Do not add infrastructure until measured needs justify it.
- Preserve the current architecture unless a documented decision changes it.
- Changes require tests proportional to their behavior and risk.
- User-facing match explanations must be derived from real matcher evidence, never invented prose.
