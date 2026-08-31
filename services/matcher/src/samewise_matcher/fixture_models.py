"""Validated models for deterministic organization benchmark fixtures."""

from __future__ import annotations

import math
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

GENERATOR_VERSION = "fixture-generator-v0.1.0"
SCHEMA_MAPPING_VERSION = "organizations-schema-v1"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CorruptionConfig(StrictModel):
    """Small, explicit probability model; this is intentionally not a DSL."""

    profile: Literal["low", "moderate", "high"] = "moderate"
    name_case_rate: float = Field(ge=0, le=1)
    name_punctuation_rate: float = Field(ge=0, le=1)
    name_suffix_rate: float = Field(ge=0, le=1)
    name_token_deletion_rate: float = Field(ge=0, le=1)
    name_abbreviation_rate: float = Field(ge=0, le=1)
    name_typo_rate: float = Field(ge=0, le=1)
    name_spacing_rate: float = Field(ge=0, le=1)
    phone_format_rate: float = Field(ge=0, le=1)
    phone_country_code_rate: float = Field(ge=0, le=1)
    phone_digit_error_rate: float = Field(ge=0, le=1)
    phone_missing_rate: float = Field(ge=0, le=1)
    email_case_rate: float = Field(ge=0, le=1)
    email_missing_rate: float = Field(ge=0, le=1)
    email_typo_rate: float = Field(ge=0, le=1)
    address_abbreviation_rate: float = Field(ge=0, le=1)
    address_format_rate: float = Field(ge=0, le=1)
    address_stale_rate: float = Field(ge=0, le=1)
    address_missing_component_rate: float = Field(ge=0, le=1)
    postal_format_rate: float = Field(ge=0, le=1)
    postal_missing_rate: float = Field(ge=0, le=1)
    postal_incorrect_rate: float = Field(ge=0, le=1)
    business_conflict_rate: float = Field(ge=0, le=1)
    timestamp_shift_rate: float = Field(ge=0, le=1)

    @classmethod
    def preset(cls, profile: Literal["low", "moderate", "high"]) -> CorruptionConfig:
        multiplier = {"low": 0.45, "moderate": 1.0, "high": 1.55}[profile]
        base = {
            "name_case_rate": 0.18,
            "name_punctuation_rate": 0.10,
            "name_suffix_rate": 0.24,
            "name_token_deletion_rate": 0.05,
            "name_abbreviation_rate": 0.08,
            "name_typo_rate": 0.08,
            "name_spacing_rate": 0.05,
            "phone_format_rate": 0.55,
            "phone_country_code_rate": 0.16,
            "phone_digit_error_rate": 0.04,
            "phone_missing_rate": 0.08,
            "email_case_rate": 0.18,
            "email_missing_rate": 0.08,
            "email_typo_rate": 0.035,
            "address_abbreviation_rate": 0.30,
            "address_format_rate": 0.14,
            "address_stale_rate": 0.04,
            "address_missing_component_rate": 0.07,
            "postal_format_rate": 0.10,
            "postal_missing_rate": 0.04,
            "postal_incorrect_rate": 0.025,
            "business_conflict_rate": 0.28,
            "timestamp_shift_rate": 0.55,
        }
        return cls(
            profile=profile,
            **{key: min(value * multiplier, 0.85) for key, value in base.items()},
        )


class FixtureConfig(StrictModel):
    fixture_name: str = Field(min_length=1, max_length=80)
    seed: int = Field(ge=0, le=2**63 - 1)
    canonical_entity_count: int = Field(ge=8, le=1_000_000)
    overlap_rate: float = Field(default=0.70, ge=0, le=1)
    a_only_rate: float = Field(default=0.15, ge=0, le=1)
    b_only_rate: float = Field(default=0.15, ge=0, le=1)
    duplicate_rows_a: int = Field(default=2, ge=0)
    duplicate_rows_b: int = Field(default=2, ge=0)
    hard_negative_pairs: int = Field(default=3, ge=1, le=3)
    corruption: CorruptionConfig

    @model_validator(mode="after")
    def validate_distribution(self) -> FixtureConfig:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", self.fixture_name):
            raise ValueError(
                "fixture_name may contain only letters, digits, '.', '_' and '-'"
            )
        if not math.isclose(
            self.overlap_rate + self.a_only_rate + self.b_only_rate,
            1.0,
            abs_tol=1e-9,
        ):
            raise ValueError("overlap_rate + a_only_rate + b_only_rate must equal 1")
        overlap, a_only, b_only = allocate_entity_counts(self)
        required_overlap = self.hard_negative_pairs * 2
        if overlap < required_overlap:
            raise ValueError(
                f"configuration needs at least {required_overlap} overlapping entities "
                "for the requested hard-negative pairs"
            )
        if self.duplicate_rows_a > overlap + a_only:
            raise ValueError("duplicate_rows_a exceeds entities present in dataset A")
        if self.duplicate_rows_b > overlap + b_only:
            raise ValueError("duplicate_rows_b exceeds entities present in dataset B")
        return self


def allocate_entity_counts(config: FixtureConfig) -> tuple[int, int, int]:
    """Allocate rates with a stable largest-remainder method."""

    rates = (config.overlap_rate, config.a_only_rate, config.b_only_rate)
    raw = [config.canonical_entity_count * rate for rate in rates]
    counts = [math.floor(value) for value in raw]
    remaining = config.canonical_entity_count - sum(counts)
    order = sorted(range(3), key=lambda index: (-(raw[index] - counts[index]), index))
    for index in order[:remaining]:
        counts[index] += 1
    return counts[0], counts[1], counts[2]


class CanonicalOrganization(StrictModel):
    canonical_entity_id: str
    organization_name: str
    phone: str
    email: str
    street_address: str
    city: str
    state_region: str
    postal_code: str
    website_domain: str
    status: Literal["active", "inactive", "on_hold"]
    balance: str
    updated_at: str


class CorruptionEvent(StrictModel):
    field: str
    strategy: str
    before: str
    after: str


class SourceRowTruth(StrictModel):
    source_row_id: str
    canonical_entity_id: str
    occurrence: Literal["primary", "duplicate"]
    corruptions: list[CorruptionEvent] = Field(default_factory=list)


class IdentityTruth(StrictModel):
    truth_format_version: Literal["1.0.0"] = "1.0.0"
    source_a: list[SourceRowTruth]
    source_b: list[SourceRowTruth]

    def canonical_id_for(self, source: Literal["A", "B"], row_id: str) -> str:
        rows = self.source_a if source == "A" else self.source_b
        return next(
            row.canonical_entity_id for row in rows if row.source_row_id == row_id
        )

    def pair_is_same(self, a_row_id: str, b_row_id: str) -> bool:
        return self.canonical_id_for("A", a_row_id) == self.canonical_id_for(
            "B", b_row_id
        )


class SchemaFieldMapping(StrictModel):
    semantic_field: str
    dataset_a_column: str
    dataset_b_column: str
    role: Literal["source_identifier", "identity_evidence", "business_value"]


class SchemaMapping(StrictModel):
    schema_mapping_version: Literal["organizations-schema-v1"] = SCHEMA_MAPPING_VERSION
    fields: list[SchemaFieldMapping]
