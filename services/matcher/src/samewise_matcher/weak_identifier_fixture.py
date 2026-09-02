"""Deterministic weak-identifier fixture policy layered over generator v0.1.0."""

from __future__ import annotations

import csv
import hashlib
import io
import json
from collections import Counter
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator

from samewise_matcher.fixture_generator import generate_fixture
from samewise_matcher.fixture_models import GENERATOR_VERSION, FixtureConfig

WEAK_FIXTURE_GENERATOR_VERSION = "weak-identifier-fixture-generator-v0.1.0"
WEAK_IDENTIFIER_POLICY_VERSION = "weak-identifier-policy-v0.1.0"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WeakIdentifierPolicy(StrictModel):
    policyVersion: Literal["weak-identifier-policy-v0.1.0"] = (
        WEAK_IDENTIFIER_POLICY_VERSION
    )
    seed: int = Field(ge=0, le=2**63 - 1)
    phoneMissingRate: float = Field(default=0.45, ge=0, le=1)
    phoneDigitCorruptionRate: float = Field(default=0.40, ge=0, le=1)
    emailMissingRate: float = Field(default=0.45, ge=0, le=1)
    emailTypoRate: float = Field(default=0.40, ge=0, le=1)
    domainMissingRate: float = Field(default=0.45, ge=0, le=1)
    domainStaleRate: float = Field(default=0.40, ge=0, le=1)
    domainFormatVariationRate: float = Field(default=0.10, ge=0, le=1)

    @model_validator(mode="after")
    def validate_exclusive_rates(self) -> WeakIdentifierPolicy:
        groups = (
            (self.phoneMissingRate, self.phoneDigitCorruptionRate),
            (self.emailMissingRate, self.emailTypoRate),
            (
                self.domainMissingRate,
                self.domainStaleRate,
                self.domainFormatVariationRate,
            ),
        )
        if any(sum(group) > 1 for group in groups):
            raise ValueError("exclusive weak-identifier rates may not exceed 1")
        return self


class WeakIdentifierFixtureConfig(StrictModel):
    fixtureGeneratorVersion: Literal["weak-identifier-fixture-generator-v0.1.0"] = (
        WEAK_FIXTURE_GENERATOR_VERSION
    )
    baseFixture: FixtureConfig
    weakIdentifierPolicy: WeakIdentifierPolicy


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    ).encode()


def _csv_bytes(rows: list[dict[str, str]], columns: list[str]) -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue().encode("utf-8")


def _read_csv(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), [dict(row) for row in reader]


def _unit_interval(seed: int, side: str, row_id: str, field: str) -> float:
    material = f"{seed}:{side}:{row_id}:{field}".encode()
    integer = int.from_bytes(hashlib.sha256(material).digest()[:8], "big")
    return integer / 2**64


def _digest(seed: int, side: str, row_id: str, field: str) -> bytes:
    return hashlib.sha256(f"{seed}:{side}:{row_id}:{field}".encode()).digest()


def _corrupt_phone(value: str, digest: bytes) -> str:
    positions = [index for index, character in enumerate(value) if character.isdigit()]
    if not positions:
        return value
    position = positions[int.from_bytes(digest[:2], "big") % len(positions)]
    replacement = str((int(value[position]) + 1 + digest[2] % 8) % 10)
    return f"{value[:position]}{replacement}{value[position + 1 :]}"


def _corrupt_email(value: str, digest: bytes) -> str:
    if value.count("@") != 1:
        return value
    local, domain = value.split("@", maxsplit=1)
    candidates = [
        index for index, character in enumerate(domain) if character.isalpha()
    ]
    if not candidates:
        return value
    position = candidates[int.from_bytes(digest[:2], "big") % len(candidates)]
    character = domain[position].lower()
    replacement = chr(((ord(character) - 97 + 1 + digest[2] % 24) % 26) + 97)
    domain = f"{domain[:position]}{replacement}{domain[position + 1 :]}"
    return f"{local}@{domain}"


def _domain_host(value: str) -> str:
    candidate = value if "://" in value else f"//{value}"
    return (urlsplit(candidate).hostname or "").removeprefix("www.")


def _stale_domain(side: str, digest: bytes) -> str:
    host = f"legacy-{digest.hex()[:12]}.invalid"
    return f"https://{host}" if side == "A" else host


def _format_domain(value: str, side: str) -> str:
    host = _domain_host(value)
    if not host:
        return value
    return f"https://www.{host}/directory" if side == "A" else f"www.{host}"


def _event(field: str, strategy: str, before: str, after: str) -> dict[str, str]:
    return {"field": field, "strategy": strategy, "before": before, "after": after}


def _apply_policy_to_row(
    row: dict[str, str],
    side: Literal["A", "B"],
    policy: WeakIdentifierPolicy,
) -> list[dict[str, str]]:
    row_id_column = "vendor_id" if side == "A" else "organization_ref"
    row_id = row[row_id_column]
    fields = {
        "phone": "phone" if side == "A" else "telephone",
        "email": "contact_email" if side == "A" else "email_address",
        "website_domain": "website" if side == "A" else "domain",
    }
    events: list[dict[str, str]] = []

    column = fields["phone"]
    before = row[column]
    draw = _unit_interval(policy.seed, side, row_id, "phone")
    if before and draw < policy.phoneMissingRate:
        row[column] = ""
        events.append(_event("phone", "weak_policy_missing", before, ""))
    elif before and draw < policy.phoneMissingRate + policy.phoneDigitCorruptionRate:
        after = _corrupt_phone(before, _digest(policy.seed, side, row_id, "phone"))
        if after != before:
            row[column] = after
            events.append(
                _event("phone", "weak_policy_digit_corruption", before, after)
            )

    column = fields["email"]
    before = row[column]
    draw = _unit_interval(policy.seed, side, row_id, "email")
    if before and draw < policy.emailMissingRate:
        row[column] = ""
        events.append(_event("email", "weak_policy_missing", before, ""))
    elif before and draw < policy.emailMissingRate + policy.emailTypoRate:
        after = _corrupt_email(before, _digest(policy.seed, side, row_id, "email"))
        if after != before:
            row[column] = after
            events.append(_event("email", "weak_policy_typo", before, after))

    column = fields["website_domain"]
    before = row[column]
    draw = _unit_interval(policy.seed, side, row_id, "website_domain")
    if before and draw < policy.domainMissingRate:
        row[column] = ""
        events.append(_event("website_domain", "weak_policy_missing", before, ""))
    elif before and draw < policy.domainMissingRate + policy.domainStaleRate:
        after = _stale_domain(
            side, _digest(policy.seed, side, row_id, "website_domain")
        )
        row[column] = after
        events.append(_event("website_domain", "weak_policy_stale", before, after))
    elif before and draw < (
        policy.domainMissingRate
        + policy.domainStaleRate
        + policy.domainFormatVariationRate
    ):
        after = _format_domain(before, side)
        if after != before:
            row[column] = after
            events.append(_event("website_domain", "weak_policy_format", before, after))
    return events


def generate_weak_identifier_fixture(
    config: WeakIdentifierFixtureConfig, output_root: Path
) -> dict[str, Any]:
    """Generate a base fixture, then apply a predeclared row-local visible policy."""

    root = output_root.resolve()
    manifest = generate_fixture(config.baseFixture, root)
    policy = config.weakIdentifierPolicy
    new_events: Counter[str] = Counter()
    provenance_path = root / manifest["artifacts"]["corruption_provenance"]["path"]
    provenance = {
        (item["source"], item["source_row_id"]): item
        for item in (
            json.loads(line)
            for line in provenance_path.read_text(encoding="utf-8").splitlines()
        )
    }

    for side, artifact in (("A", "dataset_a"), ("B", "dataset_b")):
        path = root / manifest["artifacts"][artifact]["path"]
        columns, rows = _read_csv(path)
        for row in rows:
            row_id = row[columns[0]]
            events = _apply_policy_to_row(row, side, policy)
            provenance[(side, row_id)]["corruptions"].extend(events)
            new_events.update(event["strategy"] for event in events)
        content = _csv_bytes(rows, columns)
        path.write_bytes(content)
        manifest["artifacts"][artifact]["sha256"] = hashlib.sha256(content).hexdigest()

    provenance_content = b"".join(
        _json_bytes(item).replace(b"\n", b"") + b"\n"
        for _, item in sorted(provenance.items())
    )
    provenance_path.write_bytes(provenance_content)
    manifest["artifacts"]["corruption_provenance"]["sha256"] = hashlib.sha256(
        provenance_content
    ).hexdigest()

    config_path = root / manifest["artifacts"]["config"]["path"]
    config_content = _json_bytes(config.model_dump(mode="json"))
    config_path.write_bytes(config_content)
    manifest["artifacts"]["config"]["sha256"] = hashlib.sha256(
        config_content
    ).hexdigest()
    manifest["generator_version"] = WEAK_FIXTURE_GENERATOR_VERSION
    manifest["base_generator_version"] = GENERATOR_VERSION
    manifest["requested_config"] = config.model_dump(mode="json")
    merged_counts = Counter(manifest["corruption_counts_by_strategy"])
    merged_counts.update(new_events)
    manifest["corruption_counts_by_strategy"] = dict(sorted(merged_counts.items()))
    manifest["weak_identifier_policy_version"] = policy.policyVersion

    summary_path = root / manifest["artifacts"]["summary"]["path"]
    counts = manifest["actual_counts"]
    summary = (
        f"# Weak-identifier fixture: {manifest['fixture_name']}\n\n"
        "This is a generated fixture fact report. Candidate metrics require a "
        "separate truth-blind generation and evaluation run.\n\n"
        f"- Generator: `{WEAK_FIXTURE_GENERATOR_VERSION}`\n"
        f"- Base generator: `{GENERATOR_VERSION}`\n"
        f"- Weak policy: `{policy.policyVersion}`\n"
        f"- Canonical entities: {counts['canonical_entities']}\n"
        f"- A rows: {counts['visible_rows_a']}\n"
        f"- B rows: {counts['visible_rows_b']}\n"
        f"- True cross-source pairs: {counts['true_cross_source_pairs']}\n"
    ).encode()
    summary_path.write_bytes(summary)
    manifest["artifacts"]["summary"]["sha256"] = hashlib.sha256(summary).hexdigest()

    manifest_path = (
        root
        / "evaluation"
        / "benchmarks"
        / config.baseFixture.fixture_name
        / "manifest.json"
    )
    manifest_path.write_bytes(_json_bytes(manifest))
    return manifest
