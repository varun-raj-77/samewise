# ADR 0004: Contextual compact-name blocking after falsification

- Status: Accepted
- Date: 2026-08-31

## Context

`candidate-engine-v0.1.0` retained all true pairs on the original synthetic
fixtures, whose domains were unusually strong. A fixed 1,500-entity adversarial
fixture independently weakened phone, email, and domain. V0.1 retained only
1,012/1,043 weak-identifier true pairs. Thirty of 31 misses had useful broad name
keys suppressed; many still shared the same compact normalized name plus location
or address context.

## Decision

Introduce `candidate-engine-v0.2.0` with `location_name_v2` and
`address_name_v2`. These retain the v1 token keys and add exact compact-name keys
combined with a normalized location or address number. Keep the 20-row-per-side and
100-relationship bucket limits unchanged. Preserve v0.1 config, snapshots, and
reports.

## Consequences

- Weak-identifier retention on the fixed fixture rises from 1,012/1,043 to
  1,035/1,043 while candidate count rises from 2,369 to 2,651.
- Seven remaining misses are affected by bucket suppression; one has no key
  intersection after independent name typos and incomplete address evidence.
- Exact-only blocking retains just 58/1,101 true pairs, while disabling exact
  blocking does not change v0.2 retention. The result is not dependent on exact
  identifiers in this fixture.
- Candidate recall remains distinct from final matching recall or precision.
