# ADR 0007: Versioned deterministic survivorship with a trusted-export gate

- Status: Accepted
- Date: 2026-09-01

## Context

SAME establishes identity but does not establish which conflicting source value is
true. The original development slice allowed only Use A or Use B and could export
an honest reconciliation report, but it had no reusable deterministic policies,
rule provenance, KEEP BOTH representation, or stricter merged-output contract.

## Decision

Keep survivorship in the Node orchestration layer and separate from the Python
matcher. Support a closed, validated strategy enum: manual Use A, manual Use B,
Keep Both, Prefer non-null, Prefer newest from an explicitly mapped date field,
and Prefer trusted source per mapped comparison field. No strategy executes code or
calls a model.

Store a content-versioned process-local policy. Configuration never applies a
policy. Preview is a read-only deterministic evaluation, and a separate explicit
apply request creates resolution records. Manual resolutions are skipped by rules.
Changing or clearing a resolution retains the previous compact record in the
conflict history.

Keep reconciliation and trusted output separate. The reconciliation report is
always available and exposes pending identity and field states. Trusted merged CSV
is gated until every review item is resolved and every effective confirmed link's
comparison conflicts are agreed, explicitly resolved, or deliberately KEEP BOTH.
Source-only rows remain eligible with `source_only_a` or `source_only_b`
provenance.

KEEP BOTH has no canonical cell. Trusted CSV uses dedicated `<field>__A`,
`<field>__B`, and `<field>__resolution` columns; the canonical `<field>` cell is
empty for KEEP BOTH. Every CSV cell uses the existing formula-injection defense.

## Consequences

- Identity scores and SAME decisions never select field truth.
- Policy results remain distinguishable from manual actions and reconstructable
  from policy version, rule ID, raw snapshots, optional timestamps, reason, and time.
- Invalid policies are rejected before replacing the current policy.
- Equal, missing, or malformed timestamps cannot produce an arbitrary winner.
- Existing process-local persistence remains a development limitation.
- Multiple effective links are emitted as separate provenance-bearing rows; this
  milestone does not collapse them into a multi-record golden entity.
- Rule tests establish deterministic algorithm behavior, not real-world
  survivorship accuracy.

## Alternatives considered

### Let SAME or the identity score choose the value

Rejected because identity evidence does not establish source authority or recency.

### Apply policies when they are saved

Rejected because configuration must be inspectable before it changes trusted state.

### User scripting or model-generated rules

Rejected because executable free-form output is not a safe or reproducible process
contract.
