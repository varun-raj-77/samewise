# SW-005F adversarial candidate-engine falsification

The fixed `organizations-weak-identifiers-1500-v1` fixture independently weakens
phone, email, and domain evidence with a predeclared row-local policy. Candidate
generation remains blind to identity truth; stratification, suppression analysis,
and hard-negative labels are applied only afterward.

The initial `candidate-engine-v0.1.0` run was falsified: it retained 1,070/1,101
true pairs overall and 1,012/1,043 pairs with no surviving exact phone, email, or
domain. Inspection of all 31 misses showed repeated spacing/suffix cases where broad
name keys were suppressed even though an exact compact name plus location/address
context remained available.

`candidate-engine-v0.2.0` adds only two versioned composite-key families:
`location_name_v2` and `address_name_v2`. They retain the v1 token keys and add
exact compact normalized-name keys combined with location or address number. Bucket
limits remain 20 rows per side and 100 per-key relationships.

| Engine | Candidates | Reduction | Overall retained | Overall recall | Weak retained | Weak recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| v0.1.0 | 2,369 | 718.879274x | 1,070/1,101 | 97.184378% | 1,012/1,043 | 97.027804% |
| v0.2.0 | 2,651 | 642.408525x | 1,093/1,101 | 99.273388% | 1,035/1,043 | 99.232982% |

All 58 strong-identifier pairs were retained by both versions. Removing exact
blocking from v0.2 changed neither retention nor misses. Removing address/name v2
caused the largest weak-recall loss: 944/1,043 retained. All six known cross-source
hard-negative pairs entered through name token and character blockers.

The unchanged suppression policy suppressed 437 keys representing 1,014,725
per-key relationships. Of 1,095 true pairs sharing at least one suppressed useful
key, 1,088 were retained; seven of the eight final misses were affected by
suppression. The remaining eight misses are preserved in the machine report rather
than tuned away.

The original fixtures remained at 100% candidate recall under v0.2. Candidate
counts changed from 4,246 to 4,370 at 1K and from 13,283 to 13,801 at 10K. This is a
bounded increase, not a bucket-cap relaxation.

These results support using v0.2 as input to SW-006, with the explicit risk that
plausible multi-corruption pairs can still be lost. Candidate recall is not final
matching recall or precision.
