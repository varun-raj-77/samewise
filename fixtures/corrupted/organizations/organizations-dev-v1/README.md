# Organizations development fixture v1

These two CSVs are the product-visible portion of the checked-in synthetic fixture. They intentionally use different column names and independent source row identifiers.

Across the files, a human can inspect examples of exact-looking records, name case/suffix/typo variation, missing cells, differing status and balance values, related-but-distinct organization names, and repeated or near-repeated rows. Some entities occur in only one file. The README deliberately does not identify matching pairs or disclose canonical IDs.

Tests and future evaluation code may use the separately stored ground-truth artifacts. Matcher code must not.
