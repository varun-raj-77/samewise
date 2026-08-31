"""Deterministic organization ground-truth fixture generation."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import random
import re
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from samewise_matcher.fixture_models import (
    GENERATOR_VERSION,
    SCHEMA_MAPPING_VERSION,
    CanonicalOrganization,
    CorruptionEvent,
    FixtureConfig,
    IdentityTruth,
    SchemaFieldMapping,
    SchemaMapping,
    SourceRowTruth,
    allocate_entity_counts,
)

A_COLUMNS = [
    "vendor_id",
    "vendor_name",
    "phone",
    "contact_email",
    "street",
    "city",
    "state",
    "zip",
    "website",
    "account_status",
    "balance",
    "updated_at",
]
B_COLUMNS = [
    "organization_ref",
    "organization",
    "telephone",
    "email_address",
    "address_line_1",
    "locality",
    "region",
    "postal_code",
    "domain",
    "status",
    "outstanding_balance",
    "last_updated",
]

SEMANTIC_FIELDS = [
    ("source_row_id", "vendor_id", "organization_ref", "source_identifier"),
    ("organization_name", "vendor_name", "organization", "identity_evidence"),
    ("phone", "phone", "telephone", "identity_evidence"),
    ("email", "contact_email", "email_address", "identity_evidence"),
    ("street_address", "street", "address_line_1", "identity_evidence"),
    ("city", "city", "locality", "identity_evidence"),
    ("state_region", "state", "region", "identity_evidence"),
    ("postal_code", "zip", "postal_code", "identity_evidence"),
    ("website_domain", "website", "domain", "identity_evidence"),
    ("status", "account_status", "status", "business_value"),
    ("balance", "balance", "outstanding_balance", "business_value"),
    ("updated_at", "updated_at", "last_updated", "business_value"),
]

HARD_NEGATIVE_TEMPLATES = [
    (
        "shared_name_tokens",
        "Northstar Medical Group Incorporated",
        "Northstar Medical Supply Incorporated",
    ),
    (
        "service_line_extension",
        "Acme Industrial LLC",
        "Acme Industrial Services LLC",
    ),
    (
        "singular_related_service",
        "Green Valley Foods Limited",
        "Green Valley Food Services Limited",
    ),
]

ADJECTIVES = [
    "Blue Ridge",
    "Cedar",
    "Evergreen",
    "Harbor",
    "Keystone",
    "Maple",
    "Pioneer",
    "Redwood",
    "Summit",
    "Westfield",
]
NOUNS = [
    "Analytics",
    "Dental",
    "Equipment",
    "Foods",
    "Logistics",
    "Manufacturing",
    "Office Supply",
    "Packaging",
    "Technology",
    "Wholesale",
]
SUFFIXES = ["Incorporated", "Corporation", "Limited", "LLC"]
CITIES = [
    ("Albany", "NY", "12207"),
    ("Austin", "TX", "78701"),
    ("Columbus", "OH", "43215"),
    ("Denver", "CO", "80202"),
    ("Madison", "WI", "53703"),
    ("Portland", "ME", "04101"),
    ("Raleigh", "NC", "27601"),
    ("Richmond", "VA", "23219"),
]
STREET_NAMES = [
    "Market Street",
    "Oak Avenue",
    "River Road",
    "Main Street",
    "Commerce Avenue",
    "Industrial Road",
]


@dataclass
class _DraftRow:
    canonical_id: str
    occurrence: Literal["primary", "duplicate"]
    values: dict[str, str]
    events: list[CorruptionEvent]
    source_row_id: str = ""


def _stable_rng(seed: int, *parts: str) -> random.Random:
    material = ":".join([str(seed), *parts]).encode()
    derived = int.from_bytes(hashlib.sha256(material).digest()[:8], "big")
    return random.Random(derived)


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def _canonical_entities(config: FixtureConfig) -> list[CanonicalOrganization]:
    rng = _stable_rng(config.seed, "canonical")
    entities: list[CanonicalOrganization] = []
    hard_names = [
        name
        for pair in HARD_NEGATIVE_TEMPLATES[: config.hard_negative_pairs]
        for name in pair[1:]
    ]
    base_time = datetime(2025, 1, 1, 12, 0, tzinfo=UTC)

    for index in range(config.canonical_entity_count):
        canonical_id = f"entity_{index + 1:06d}"
        if index < len(hard_names):
            name = hard_names[index]
        else:
            serial = index - len(hard_names)
            suffix_index = (serial // (len(ADJECTIVES) * len(NOUNS))) % len(SUFFIXES)
            name = (
                f"{ADJECTIVES[serial % len(ADJECTIVES)]} "
                f"{NOUNS[(serial // len(ADJECTIVES)) % len(NOUNS)]} "
                f"{SUFFIXES[suffix_index]}"
            )
            if serial >= len(ADJECTIVES) * len(NOUNS) * len(SUFFIXES):
                name = f"{name} {serial + 1}"
        city, state, postal = CITIES[index % len(CITIES)]
        street_number = 100 + ((index * 37 + rng.randrange(17)) % 9800)
        street = f"{street_number} {STREET_NAMES[index % len(STREET_NAMES)]}"
        phone_tail = 1000 + ((index * 7919 + rng.randrange(997)) % 9000)
        phone = f"555-01{index % 10}-{phone_tail:04d}"
        domain = f"{_slug(name)[:24] or 'organization'}{index + 17}.example"
        email = f"accounts@{domain}"
        balance = f"{(12500 + index * 1379 + rng.randrange(8000)) / 100:.2f}"
        updated = base_time + timedelta(days=rng.randrange(700), hours=index % 12)
        entities.append(
            CanonicalOrganization(
                canonical_entity_id=canonical_id,
                organization_name=name,
                phone=phone,
                email=email,
                street_address=street,
                city=city,
                state_region=state,
                postal_code=postal,
                website_domain=domain,
                status=("active", "inactive", "on_hold")[index % 3],
                balance=balance,
                updated_at=updated.isoformat().replace("+00:00", "Z"),
            )
        )
    return entities


def _record_event(
    values: dict[str, str],
    events: list[CorruptionEvent],
    field: str,
    strategy: str,
    after: str,
) -> None:
    before = values[field]
    if after != before:
        values[field] = after
        events.append(
            CorruptionEvent(field=field, strategy=strategy, before=before, after=after)
        )


def _small_typo(value: str, rng: random.Random) -> str:
    candidates = [index for index, char in enumerate(value) if char.isalpha()]
    if not candidates:
        return value
    index = rng.choice(candidates)
    replacement = chr(((ord(value[index].lower()) - 97 + 1) % 26) + 97)
    if value[index].isupper():
        replacement = replacement.upper()
    return value[:index] + replacement + value[index + 1 :]


def _corrupt(
    entity: CanonicalOrganization,
    source: Literal["A", "B"],
    occurrence_index: int,
    config: FixtureConfig,
    *,
    preserve_name: bool,
    exact: bool,
) -> tuple[dict[str, str], list[CorruptionEvent]]:
    values = entity.model_dump(exclude={"canonical_entity_id"})
    events: list[CorruptionEvent] = []
    if exact:
        return values, events

    rng = _stable_rng(
        config.seed,
        "corrupt",
        source,
        entity.canonical_entity_id,
        str(occurrence_index),
    )
    rates = config.corruption

    if not preserve_name:
        if rng.random() < rates.name_case_rate:
            _record_event(
                values,
                events,
                "organization_name",
                "case_change",
                values["organization_name"].upper(),
            )
        if rng.random() < rates.name_punctuation_rate:
            changed = values["organization_name"].replace(".", "").replace(",", "")
            _record_event(
                values, events, "organization_name", "punctuation_removal", changed
            )
        if rng.random() < rates.name_suffix_rate:
            changed = values["organization_name"]
            for long, short in (
                ("Incorporated", "Inc"),
                ("Corporation", "Corp"),
                ("Limited", "Ltd"),
            ):
                changed = changed.replace(long, short)
            _record_event(
                values,
                events,
                "organization_name",
                "corporate_suffix_variation",
                changed,
            )
        if rng.random() < rates.name_token_deletion_rate:
            tokens = values["organization_name"].split()
            protected = {
                "Inc",
                "Incorporated",
                "Corp",
                "Corporation",
                "Ltd",
                "Limited",
                "LLC",
            }
            removable = [i for i, token in enumerate(tokens) if token not in protected]
            if len(removable) > 1:
                del tokens[rng.choice(removable)]
                _record_event(
                    values,
                    events,
                    "organization_name",
                    "token_deletion",
                    " ".join(tokens),
                )
        if rng.random() < rates.name_abbreviation_rate:
            changed = (
                values["organization_name"]
                .replace("Services", "Svcs")
                .replace("Supply", "Sup")
            )
            _record_event(values, events, "organization_name", "abbreviation", changed)
        if rng.random() < rates.name_typo_rate:
            _record_event(
                values,
                events,
                "organization_name",
                "small_typo",
                _small_typo(values["organization_name"], rng),
            )
        if rng.random() < rates.name_spacing_rate:
            tokens = values["organization_name"].split()
            if len(tokens) > 1:
                position = rng.randrange(len(tokens) - 1)
                tokens[position : position + 2] = [
                    tokens[position] + tokens[position + 1]
                ]
                _record_event(
                    values,
                    events,
                    "organization_name",
                    "token_spacing",
                    " ".join(tokens),
                )

    if rng.random() < rates.phone_format_rate and values["phone"]:
        digits = re.sub(r"\D", "", values["phone"])
        changed = (
            f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"
            if source == "A"
            else f"{digits[:3]}.{digits[3:6]}.{digits[6:]}"
        )
        _record_event(values, events, "phone", "format_change", changed)
    if rng.random() < rates.phone_country_code_rate and values["phone"]:
        _record_event(
            values, events, "phone", "country_code_added", f"+1 {values['phone']}"
        )
    if rng.random() < rates.phone_digit_error_rate and values["phone"]:
        digits = [i for i, char in enumerate(values["phone"]) if char.isdigit()]
        index = rng.choice(digits)
        replacement = str((int(values["phone"][index]) + 1) % 10)
        _record_event(
            values,
            events,
            "phone",
            "one_digit_error",
            values["phone"][:index] + replacement + values["phone"][index + 1 :],
        )
    if rng.random() < rates.phone_missing_rate:
        _record_event(values, events, "phone", "missing_value", "")

    if rng.random() < rates.email_case_rate and values["email"]:
        local, domain = values["email"].split("@", maxsplit=1)
        _record_event(
            values, events, "email", "local_part_case", f"{local.upper()}@{domain}"
        )
    if rng.random() < rates.email_typo_rate and values["email"]:
        local, domain = values["email"].split("@", maxsplit=1)
        _record_event(
            values,
            events,
            "email",
            "domain_typo",
            f"{local}@{_small_typo(domain, rng)}",
        )
    if rng.random() < rates.email_missing_rate:
        _record_event(values, events, "email", "missing_value", "")

    if rng.random() < rates.address_abbreviation_rate:
        changed = (
            values["street_address"]
            .replace("Street", "St")
            .replace("Road", "Rd")
            .replace("Avenue", "Ave")
        )
        _record_event(
            values, events, "street_address", "street_type_abbreviation", changed
        )
    if rng.random() < rates.address_format_rate:
        _record_event(
            values,
            events,
            "street_address",
            "punctuation_spacing",
            values["street_address"].replace(" ", "  ", 1),
        )
    if rng.random() < rates.address_stale_rate:
        number, rest = values["street_address"].split(" ", maxsplit=1)
        _record_event(
            values,
            events,
            "street_address",
            "stale_address",
            f"{int(number) + 10} {rest}",
        )
    if rng.random() < rates.address_missing_component_rate:
        tokens = values["street_address"].split()
        _record_event(
            values,
            events,
            "street_address",
            "missing_street_type",
            " ".join(tokens[:-1]),
        )

    if rng.random() < rates.postal_format_rate and len(values["postal_code"]) == 5:
        _record_event(
            values,
            events,
            "postal_code",
            "extended_format",
            f"{values['postal_code']}-0000",
        )
    if rng.random() < rates.postal_incorrect_rate and values["postal_code"]:
        _record_event(
            values,
            events,
            "postal_code",
            "incorrect_value",
            f"{(int(values['postal_code'][:5]) + 1):05d}",
        )
    if rng.random() < rates.postal_missing_rate:
        _record_event(values, events, "postal_code", "missing_value", "")

    if rng.random() < rates.business_conflict_rate:
        statuses = [
            status
            for status in ("active", "inactive", "on_hold")
            if status != values["status"]
        ]
        _record_event(
            values, events, "status", "source_business_value", rng.choice(statuses)
        )
        amount = float(values["balance"]) + rng.choice((-27.50, 14.25, 63.00))
        _record_event(
            values, events, "balance", "source_business_value", f"{amount:.2f}"
        )
    if rng.random() < rates.timestamp_shift_rate:
        timestamp = datetime.fromisoformat(values["updated_at"].replace("Z", "+00:00"))
        shifted = timestamp + timedelta(
            days=rng.randint(1, 45), hours=rng.randint(0, 12)
        )
        _record_event(
            values,
            events,
            "updated_at",
            "source_timestamp_shift",
            shifted.isoformat().replace("+00:00", "Z"),
        )
    return values, events


def _partition_entities(
    config: FixtureConfig, entities: list[CanonicalOrganization]
) -> tuple[list[str], list[str], list[str]]:
    overlap_count, a_only_count, _ = allocate_entity_counts(config)
    hard_count = config.hard_negative_pairs * 2
    hard_ids = [entity.canonical_entity_id for entity in entities[:hard_count]]
    remaining = [entity.canonical_entity_id for entity in entities[hard_count:]]
    _stable_rng(config.seed, "partition").shuffle(remaining)
    overlap = hard_ids + remaining[: overlap_count - hard_count]
    a_only = remaining[
        overlap_count - hard_count : overlap_count - hard_count + a_only_count
    ]
    b_only = remaining[overlap_count - hard_count + a_only_count :]
    return overlap, a_only, b_only


def _build_source_rows(
    source: Literal["A", "B"],
    entity_ids: list[str],
    duplicate_count: int,
    entities: dict[str, CanonicalOrganization],
    config: FixtureConfig,
    overlap_ids: list[str],
) -> list[_DraftRow]:
    duplicate_rng = _stable_rng(config.seed, "duplicates", source)
    duplicate_ids = duplicate_rng.sample(entity_ids, duplicate_count)
    occurrences = [(entity_id, "primary", 0) for entity_id in entity_ids]
    occurrences.extend((entity_id, "duplicate", 1) for entity_id in duplicate_ids)
    hard_ids = {
        f"entity_{index + 1:06d}" for index in range(config.hard_negative_pairs * 2)
    }
    exact_id = (
        overlap_ids[config.hard_negative_pairs * 2]
        if len(overlap_ids) > config.hard_negative_pairs * 2
        else None
    )
    rows: list[_DraftRow] = []
    for entity_id, occurrence, occurrence_index in occurrences:
        values, events = _corrupt(
            entities[entity_id],
            source,
            occurrence_index,
            config,
            preserve_name=entity_id in hard_ids,
            exact=entity_id == exact_id and occurrence == "primary",
        )
        rows.append(_DraftRow(entity_id, occurrence, values, events))
    _stable_rng(config.seed, "row-order", source).shuffle(rows)
    for index, row in enumerate(rows, start=1):
        row.source_row_id = f"{source}{index:06d}"
    return rows


def _visible_row(row: _DraftRow, source: Literal["A", "B"]) -> dict[str, str]:
    values = row.values
    if source == "A":
        return dict(
            zip(
                A_COLUMNS,
                [
                    row.source_row_id,
                    values["organization_name"],
                    values["phone"],
                    values["email"],
                    values["street_address"],
                    values["city"],
                    values["state_region"],
                    values["postal_code"],
                    f"https://{values['website_domain']}",
                    values["status"],
                    values["balance"],
                    values["updated_at"],
                ],
                strict=True,
            )
        )
    return dict(
        zip(
            B_COLUMNS,
            [
                row.source_row_id,
                values["organization_name"],
                values["phone"],
                values["email"],
                values["street_address"],
                values["city"],
                values["state_region"],
                values["postal_code"],
                values["website_domain"],
                values["status"],
                values["balance"],
                values["updated_at"],
            ],
            strict=True,
        )
    )


def _csv_bytes(rows: list[dict[str, str]], columns: list[str]) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue().encode("utf-8")


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    ).encode()


def _jsonl_bytes(values: list[dict[str, Any]]) -> bytes:
    return b"".join(
        (json.dumps(value, sort_keys=True, ensure_ascii=False) + "\n").encode()
        for value in values
    )


def _sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _summary_markdown(manifest: dict[str, Any]) -> str:
    counts = manifest["actual_counts"]
    corruptions = manifest["corruption_counts_by_strategy"]
    patterns = manifest["hard_negative_patterns"]
    corruption_lines = (
        "\n".join(
            f"- `{strategy}`: {count}"
            for strategy, count in sorted(corruptions.items())
        )
        or "- None"
    )
    pattern_lines = "\n".join(f"- `{pattern}`" for pattern in patterns)
    return f"""# Fixture summary: {manifest["fixture_name"]}

This report describes generated data facts only. No matcher was run, so it makes
no precision, recall, accuracy, candidate-recall, or blocking claims.

## Counts

- Canonical entities: {counts["canonical_entities"]}
- Visible rows in dataset A: {counts["visible_rows_a"]}
- Visible rows in dataset B: {counts["visible_rows_b"]}
- Overlapping canonical entities: {counts["overlapping_entities"]}
- A-only canonical entities: {counts["a_only_entities"]}
- B-only canonical entities: {counts["b_only_entities"]}
- Duplicate rows in A: {counts["duplicate_rows_a"]}
- Duplicate rows in B: {counts["duplicate_rows_b"]}
- True cross-source identity links: {counts["true_cross_source_pairs"]}
- Theoretical A × B pairs: {counts["theoretical_cross_source_pairs"]}
- Hard-negative canonical pairs: {counts["hard_negative_pairs"]}

## Corruptions by strategy

{corruption_lines}

## Hard-negative patterns

{pattern_lines}

The hard negatives are distinct canonical entities despite deliberately similar
visible evidence. Business-field disagreements among true identity pairs are fixture
inputs for future survivorship work; they are not identity labels.
"""


def generate_fixture(config: FixtureConfig, output_root: Path) -> dict[str, Any]:
    """Generate all deterministic artifacts beneath a repository-shaped root."""

    output_root = output_root.resolve()
    entities = _canonical_entities(config)
    entity_map = {entity.canonical_entity_id: entity for entity in entities}
    overlap_ids, a_only_ids, b_only_ids = _partition_entities(config, entities)
    a_rows = _build_source_rows(
        "A",
        overlap_ids + a_only_ids,
        config.duplicate_rows_a,
        entity_map,
        config,
        overlap_ids,
    )
    b_rows = _build_source_rows(
        "B",
        overlap_ids + b_only_ids,
        config.duplicate_rows_b,
        entity_map,
        config,
        overlap_ids,
    )

    truth = IdentityTruth(
        source_a=[
            SourceRowTruth(
                source_row_id=row.source_row_id,
                canonical_entity_id=row.canonical_id,
                occurrence=row.occurrence,
                corruptions=row.events,
            )
            for row in a_rows
        ],
        source_b=[
            SourceRowTruth(
                source_row_id=row.source_row_id,
                canonical_entity_id=row.canonical_id,
                occurrence=row.occurrence,
                corruptions=row.events,
            )
            for row in b_rows
        ],
    )
    schema_mapping = SchemaMapping(
        fields=[
            SchemaFieldMapping(
                semantic_field=semantic,
                dataset_a_column=a,
                dataset_b_column=b,
                role=role,
            )
            for semantic, a, b, role in SEMANTIC_FIELDS
        ]
    )
    hard_negatives = [
        {
            "left_canonical_entity_id": f"entity_{index * 2 + 1:06d}",
            "right_canonical_entity_id": f"entity_{index * 2 + 2:06d}",
            "pattern": template[0],
            "description": (
                "Deliberately similar organizations that remain distinct entities."
            ),
        }
        for index, template in enumerate(
            HARD_NEGATIVE_TEMPLATES[: config.hard_negative_pairs]
        )
    ]

    base_paths = {
        "canonical_entities": Path("fixtures/canonical/organizations")
        / config.fixture_name
        / "canonical_entities.jsonl",
        "dataset_a": Path("fixtures/corrupted/organizations")
        / config.fixture_name
        / "dataset_a.csv",
        "dataset_b": Path("fixtures/corrupted/organizations")
        / config.fixture_name
        / "dataset_b.csv",
        "identity_truth": Path("fixtures/ground-truth/organizations")
        / config.fixture_name
        / "identity_truth.json",
        "schema_mapping": Path("fixtures/ground-truth/organizations")
        / config.fixture_name
        / "schema_mapping.json",
        "corruption_provenance": Path("fixtures/ground-truth/organizations")
        / config.fixture_name
        / "corruption_provenance.jsonl",
        "hard_negatives": Path("fixtures/adversarial/organizations")
        / config.fixture_name
        / "hard_negatives.json",
        "config": Path("evaluation/benchmarks") / config.fixture_name / "config.json",
        "summary": Path("evaluation/reports") / config.fixture_name / "summary.md",
    }
    provenance = [
        {"source": source, **row.model_dump(mode="json")}
        for source, rows in (("A", truth.source_a), ("B", truth.source_b))
        for row in rows
    ]
    contents: dict[str, bytes] = {
        "canonical_entities": _jsonl_bytes(
            [entity.model_dump(mode="json") for entity in entities]
        ),
        "dataset_a": _csv_bytes([_visible_row(row, "A") for row in a_rows], A_COLUMNS),
        "dataset_b": _csv_bytes([_visible_row(row, "B") for row in b_rows], B_COLUMNS),
        "identity_truth": _json_bytes(
            truth.model_dump(
                mode="json",
                exclude={
                    "source_a": {"__all__": {"corruptions"}},
                    "source_b": {"__all__": {"corruptions"}},
                },
            )
        ),
        "schema_mapping": _json_bytes(schema_mapping.model_dump(mode="json")),
        "corruption_provenance": _jsonl_bytes(provenance),
        "hard_negatives": _json_bytes({"patterns": hard_negatives}),
        "config": _json_bytes(config.model_dump(mode="json")),
    }

    a_counts = Counter(row.canonical_id for row in a_rows)
    b_counts = Counter(row.canonical_id for row in b_rows)
    corruption_counts = Counter(
        event.strategy for row in [*a_rows, *b_rows] for event in row.events
    )
    actual_counts = {
        "canonical_entities": len(entities),
        "visible_rows_a": len(a_rows),
        "visible_rows_b": len(b_rows),
        "overlapping_entities": len(overlap_ids),
        "a_only_entities": len(a_only_ids),
        "b_only_entities": len(b_only_ids),
        "duplicate_rows_a": sum(count - 1 for count in a_counts.values()),
        "duplicate_rows_b": sum(count - 1 for count in b_counts.values()),
        "true_cross_source_pairs": sum(
            a_counts[entity_id] * b_counts[entity_id] for entity_id in overlap_ids
        ),
        "theoretical_cross_source_pairs": len(a_rows) * len(b_rows),
        "hard_negative_pairs": len(hard_negatives),
    }
    manifest: dict[str, Any] = {
        "fixture_name": config.fixture_name,
        "fixture_format_version": "1.0.0",
        "generator_version": GENERATOR_VERSION,
        "schema_mapping_version": SCHEMA_MAPPING_VERSION,
        "seed": config.seed,
        "requested_config": config.model_dump(mode="json"),
        "actual_counts": actual_counts,
        "corruption_counts_by_strategy": dict(sorted(corruption_counts.items())),
        "hard_negative_patterns": [item["pattern"] for item in hard_negatives],
        "artifacts": {},
    }
    summary_content = _summary_markdown(manifest).encode()
    contents["summary"] = summary_content

    for key, relative_path in base_paths.items():
        content = contents[key]
        destination = output_root / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        manifest["artifacts"][key] = {
            "path": relative_path.as_posix(),
            "sha256": _sha256(content),
        }

    manifest_path = (
        output_root
        / "evaluation"
        / "benchmarks"
        / config.fixture_name
        / "manifest.json"
    )
    manifest_path.write_bytes(_json_bytes(manifest))
    return manifest


def load_manifest(output_root: Path, fixture_name: str) -> dict[str, Any]:
    path = output_root / "evaluation" / "benchmarks" / fixture_name / "manifest.json"
    return json.loads(path.read_text(encoding="utf-8"))


def summarize_fixture(output_root: Path, fixture_name: str) -> str:
    return _summary_markdown(load_manifest(output_root, fixture_name))
