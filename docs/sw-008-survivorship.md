# SW-008 survivorship and trusted merged output

## State model

`FieldConflict` is created only for an effective SAME/system match and a mapped
comparison field whose raw strings differ. It carries run, candidate/identity,
mapping/column, raw A/B, status, current resolution, and compact prior-resolution
history. SAME creates zero resolutions.

A resolution records strategy, source (`manual`, `rule`, or `keep_both`), chosen
source/value or two kept values, deterministic reason/code, policy/rule version,
raw inputs, relevant configured timestamps, and resolution time. Clearing returns
the conflict to unresolved while preserving the previous record. Identity undo
remains blocked while a dependent current resolution exists and becomes eligible
after it is cleared.

## Strategies

- **Use A / Use B:** explicit user selection of the corresponding raw value.
- **Keep Both:** deliberate resolution with no canonical winner. Internally it is
  an ordered `[{source: A, value}, {source: B, value}]` value list.
- **Prefer non-null:** missing means only empty or whitespace-only in the current
  parsed string representation. Exactly one missing side selects the other. Two
  populated disagreements and two missing values remain unresolved. Literal
  `NULL`, `N/A`, and similar strings are not reinterpreted.
- **Prefer newest:** requires an explicitly mapped field whose normalizer is
  `date`. Both sides must be present, ISO-shaped, and parseable. The later instant
  wins. Equal instants, missing values, invalid calendar dates, and malformed
  strings remain unresolved. File upload time and wall-clock time are never used.
- **Prefer trusted source:** trust is configured per semantic comparison field and
  must name A or B. A missing trusted value remains unresolved; there is no hidden
  non-null fallback.

The rule model is a closed enum. There is no custom script, dynamic transformation,
or AI resolution path.

## Policy preview and apply

Policy versions are derived from the ordered validated configuration under
`survivorship-policy-v1`. Target fields must be mapped comparison fields, trusted
sources must be A/B, and newest timestamp mappings must be mapped date fields.
Validation completes before the current policy is replaced.

Saving only configures. Preview reports affected, resolvable, unresolved, and
manual-skipped counts plus per-conflict reasons. Apply is a separate request and
mutates only preview-resolvable conflicts. Existing manual and rule resolutions are
preserved; the user must clear or explicitly replace one before a new rule can own
it. Repeated application is idempotent with respect to effective state.

## Exports

The reconciliation report is formula-safe and always available. It includes
pending identity, unresolved conflicts, selected strategy/source/reason/policy,
source row IDs and values, source SHA-256 fingerprints, mapping/candidate/matcher
versions, and source-only states.

Trusted merged output is blocked while any identity review item is active/deferred
or any effective comparison conflict is unresolved. Equal fields need no conflict;
Use A, Use B, rule resolutions, and KEEP BOTH count as deliberate resolution.
Source-only rows are included honestly because no cross-source winner is needed.

For every comparison field trusted CSV emits:

```text
<field>
<field>__A
<field>__B
<field>__resolution
<field>__resolution_source
<field>__reason
```

KEEP BOTH leaves `<field>` empty and preserves both dedicated source columns.
Identity-role mappings remain evidence, not survivorship-controlled canonical
fields, and are therefore not silently merged into trusted values.

## Limits and evaluation

State, policy, history, and resolution records are process-local. Multiple linked
source rows are emitted as separate effective links; Samewise does not silently
collapse them into an enterprise golden record. Synthetic tests verify rule
correctness and safety, not whether a source is correct in the real world.
