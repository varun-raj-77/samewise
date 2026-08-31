# Fixture summary: organizations-dev-v1

This report describes generated data facts only. No matcher was run, so it makes
no precision, recall, accuracy, candidate-recall, or blocking claims.

## Counts

- Canonical entities: 24
- Visible rows in dataset A: 23
- Visible rows in dataset B: 22
- Overlapping canonical entities: 17
- A-only canonical entities: 4
- B-only canonical entities: 3
- Duplicate rows in A: 2
- Duplicate rows in B: 2
- True cross-source identity links: 21
- Theoretical A × B pairs: 506
- Hard-negative canonical pairs: 3

## Corruptions by strategy

- `case_change`: 6
- `corporate_suffix_variation`: 3
- `country_code_added`: 6
- `domain_typo`: 1
- `extended_format`: 6
- `format_change`: 27
- `local_part_case`: 11
- `missing_street_type`: 4
- `missing_value`: 7
- `one_digit_error`: 3
- `punctuation_spacing`: 2
- `small_typo`: 4
- `source_business_value`: 34
- `source_timestamp_shift`: 21
- `stale_address`: 1
- `street_type_abbreviation`: 18
- `token_spacing`: 2

## Hard-negative patterns

- `shared_name_tokens`
- `service_line_extension`
- `singular_related_service`

The hard negatives are distinct canonical entities despite deliberately similar
visible evidence. Business-field disagreements among true identity pairs are fixture
inputs for future survivorship work; they are not identity labels.
