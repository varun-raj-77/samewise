import hashlib
from pathlib import Path

import pytest

from samewise_matcher.baseline import (
    CsvInputError,
    compare_field,
    match_csvs,
    normalize,
    profile_csv,
)
from samewise_matcher.workflow_models import MATCHER_VERSION, ManualMapping


def write_csv(path: Path, text: str) -> None:
    path.write_bytes(text.encode())


def mapping(
    mapping_id: str,
    a_column: str,
    b_column: str,
    role: str = "identity",
    normalizer: str = "text",
) -> ManualMapping:
    return ManualMapping.model_validate(
        {
            "mappingId": mapping_id,
            "label": mapping_id,
            "aColumn": a_column,
            "bColumn": b_column,
            "role": role,
            "normalizer": normalizer,
        }
    )


def test_profile_reports_modest_types_rates_and_limited_samples(tmp_path: Path) -> None:
    source = tmp_path / "source.csv"
    write_csv(
        source,
        "id,name,balance,active,date\n1,Acme,12.50,true,2026-01-01\n2,,7,false,2026-02-03\n",
    )
    digest = hashlib.sha256(source.read_bytes()).hexdigest()

    profile = profile_csv(source, "dataset-a", "A", "source.csv", digest)

    assert profile.rowCount == 2
    assert [column.inferredType for column in profile.columns] == [
        "integer",
        "string",
        "number",
        "boolean",
        "date",
    ]
    name = profile.columns[1]
    assert (name.nullCount, name.nullRate, name.distinctCount) == (1, 0.5, 1)
    assert name.samples == ["Acme"]
    assert all(len(column.samples) <= 3 for column in profile.columns)


def test_explicit_baseline_normalization() -> None:
    assert normalize("  ACME—Incorporated  ", "text") == "acme incorporated"
    assert normalize("+1 (555) 010-1000", "phone") == "5550101000"
    assert normalize(" Accounts@Example.COM ", "email") == "accounts@example.com"
    assert normalize("1,200.00", "number") == "1200"
    assert normalize("2026-01-01T00:00:00Z", "date").endswith("+00:00")


def test_evidence_is_inspectable_and_handles_missing_values() -> None:
    item = mapping("phone", "phone", "telephone", normalizer="phone")
    exact = compare_field(item, "(555) 010-1000", "+1 555 010 1000")
    missing = compare_field(item, "", "555-010-1000")
    both_missing = compare_field(item, "", "")
    assert (exact.outcome, exact.contribution) == ("exact", 1)
    assert (missing.outcome, missing.contribution) == ("missing_one", 0)
    assert both_missing.outcome == "missing_both"
    assert exact.normalizedA == exact.normalizedB


def test_match_is_deterministic_versioned_and_ignores_comparison_fields(
    tmp_path: Path,
) -> None:
    a_path, b_path = tmp_path / "a.csv", tmp_path / "b.csv"
    write_csv(a_path, "id,name,status\nA1,Acme Incorporated,=danger\n")
    write_csv(
        b_path,
        "id,organization,status\nB1,ACME Incorporated,inactive\nB2,Other Co,active\n",
    )
    mappings = [
        mapping("name", "name", "organization"),
        mapping("status", "status", "status", "comparison"),
    ]

    first = match_csvs(a_path, b_path, mappings)
    second = match_csvs(a_path, b_path, mappings)

    assert first == second
    assert first.matcherVersion == MATCHER_VERSION
    assert first.candidates[0].baselineScore == 1
    assert [item.mappingId for item in first.candidates[0].evidence] == ["name"]


def test_alternative_candidate_is_not_consumed_when_primary_is_proposed(
    tmp_path: Path,
) -> None:
    a_path, b_path = tmp_path / "a.csv", tmp_path / "b.csv"
    write_csv(a_path, "id,name\nA1,Acme\n")
    write_csv(b_path, "id,name\nB1,Acme\nB2,Acmee\n")

    result = match_csvs(a_path, b_path, [mapping("name", "name", "name")])

    assert [(item.bRowId, item.rank) for item in result.candidates] == [
        ("B1", 1),
        ("B2", 2),
    ]
    assert result.candidates[0].band == "proposed_match"
    assert [row["rowId"] for row in result.onlyB] == ["B2"]


def test_collision_candidate_membership_does_not_create_an_identity_link(
    tmp_path: Path,
) -> None:
    a_path, b_path = tmp_path / "a.csv", tmp_path / "b.csv"
    write_csv(a_path, "id,name\nA1,Acme\nA2,Acme\n")
    write_csv(b_path, "id,name\nB1,Acme\n")

    result = match_csvs(a_path, b_path, [mapping("name", "name", "name")])

    assert all(item.collision for item in result.candidates)
    assert all(item.band == "needs_review" for item in result.candidates)
    assert [row["rowId"] for row in result.onlyB] == ["B1"]


def test_source_bytes_are_unchanged_by_profile_and_match(tmp_path: Path) -> None:
    a_path, b_path = tmp_path / "a.csv", tmp_path / "b.csv"
    write_csv(a_path, "id,name\nA1,Acme\n")
    write_csv(b_path, "id,name\nB1,Acme\n")
    before = [
        hashlib.sha256(path.read_bytes()).hexdigest() for path in (a_path, b_path)
    ]

    profile_csv(a_path, "a", "A", "a.csv", before[0])
    match_csvs(a_path, b_path, [mapping("name", "name", "name")])

    after = [hashlib.sha256(path.read_bytes()).hexdigest() for path in (a_path, b_path)]
    assert after == before


def test_malformed_csv_has_safe_failure(tmp_path: Path) -> None:
    malformed = tmp_path / "malformed.csv"
    write_csv(malformed, 'id,name\n1,"unclosed\n')
    with pytest.raises(CsvInputError, match="CSV could not be parsed"):
        profile_csv(malformed, "bad", "A", "bad.csv", "a" * 64)
