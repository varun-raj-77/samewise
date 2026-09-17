# Power Query reproduction guide

Status: **DOCUMENTED CAPABILITY — NOT EXECUTED**.

No Excel or Power Query run was performed for SW-013. This package makes a fair
manual reproduction possible without adding Power Query as a Samewise dependency.
Use `dataset_a.csv` and `dataset_b.csv`; keep `expected_truth.csv` closed until
after observations are recorded. Always filter both inputs to one `scenario_id`
before comparing them so candidates cannot cross scenario boundaries.

## Common setup

1. In Excel or Power BI, import both CSVs with **Get Data > Text/CSV**.
2. Preserve `record_id` as text. Treat phone and postal values as text.
3. Duplicate or reference the raw queries before applying transformations.
4. For each scenario, filter A and B to the same `scenario_id`.
5. Record the application/version, query M, settings, row counts, elapsed time if
   measured, and observed links in `result-template.md`.
6. Only after saving the observations, compare against `expected_truth.csv`.

## S01 — clean exact join

Attempt an inner merge on `stable_id`. Then run left anti and right anti merges to
identify source-only rows; a full outer merge is also valid.

Expected observation: two exact links, one A-only row, and one B-only row. Power
Query should be preferred. Samewise adds little.

## S02 — normalized multi-field join

In referenced queries, trim and lowercase name/city/region/email, remove or replace
name/address punctuation, normalize common street suffixes, and keep only phone
digits. Merge on a competent set such as normalized name + address + city, or exact
email + phone after normalization. Retain the applied steps.

Expected observation: one deterministic link and one source-only row per side.
Power Query should be preferred if these transformations are acceptable business
rules.

## S03 — simple fuzzy text

Run fuzzy merge on `name` with the default threshold, **Show similarity scores**,
and at least two returned matches. Repeat with a transformation table mapping
`Incorporated` to `Inc`. Inspect the address and contact fields before accepting.

Expected observation: `Acme Incorporated` should plausibly select `Acme Inc`. This
is documentary, not an assertion that Power Query produced a particular score.

## S04 — contradictory evidence

Try both approaches:

1. fuzzy merge on `name`, returning all plausible rows and similarity scores;
2. create a composite comparison text from name/address/city/phone and fuzzy merge
   that value.

Record whether the result makes the exact-phone disagreement and competing exact
phone candidate visible enough for a safe decision. Do not reduce the observation
to “Power Query failed”; capture the settings and what evidence was visible.

## S05 — near-tie ambiguity

Fuzzy merge on `name` with two returned matches. Repeat with composite text and
with deterministic joins on email/address as separate diagnostic queries. Compare
how the different queries rank the address/location candidate versus the exact-email
candidate.

Expected observation: multiple reasonable rules disagree. Measure reviewer effort,
not merely whether one rule happens to match hidden truth.

## S06 — collision

Fuzzy merge A to B with multiple matches enabled. Group the expanded result by
`b.record_id` and count distinct A records. Flag counts greater than one.

Expected observation: two A rows target `B-CL-401`. Power Query can expose the
collision with explicit transformations; an independent top-1 merge alone can hide
the assignment issue. Samewise also does not solve global assignment.

## S07 — identity versus survivorship

Merge on `stable_id`, then expand both source values for address, phone, contact,
and updated date. Create explicit survivor columns using documented business rules,
but do not overwrite raw queries.

Expected observation: identity is easy, value selection is a separate policy task.
Power Query can implement deterministic transformations; DataMatch is the stronger
direct survivorship comparator.

## S08 — matcher regression

Save one query version and duplicate it. Change one normalization, threshold, or
fuzzy setting only in the duplicate. Materialize both result sets and compare links
with full outer/anti joins against the truth after results are frozen.

Expected observation: this is possible, but the amount of manual versioning,
metric calculation, and error categorization should be recorded. Do not assume
Power Query lacks external version control or test harnesses.

## S09 — audit and reproducibility

Save the workbook/PBIX, export or copy the M queries, and capture source file hashes
outside Power Query if desired. Refresh twice without changes and compare outputs.

Expected observation: Applied Steps provide meaningful repeatability. Record what
is and is not automatically bound together: source identities, query versions,
reviewer decisions, survivor policy, and output hashes.

## S10 — reviewer throughput

Use fuzzy merge with multiple matches, expand candidate rows and scores, then build
a review sheet/table. Attempt at least ten representative actions or all four A
cases: choose a candidate, mark non-match, defer, revisit, and correct a prior
choice. Record clicks/keystrokes, context switching, collision visibility, and how
the selection feeds survivorship.

Expected observation: the comparison is about workflow, not match accuracy. A
competent custom Excel solution may be sufficient at small volume; record its
actual effort rather than assuming a product boundary.

## Official capability basis

- [Merge queries overview](https://learn.microsoft.com/en-us/power-query/merge-queries-overview)
- [Fuzzy merge](https://learn.microsoft.com/en-us/power-query/merge-queries-fuzzy-match)
- [How fuzzy matching works](https://learn.microsoft.com/en-us/power-query/fuzzy-matching)
- [Fuzzy grouping](https://learn.microsoft.com/en-us/powerquery-m/table-fuzzygroup)
- [Applied steps](https://learn.microsoft.com/en-us/power-query/applied-steps)
