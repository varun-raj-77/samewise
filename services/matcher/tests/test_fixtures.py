import csv
import hashlib
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from samewise_matcher.cli import main
from samewise_matcher.fixture_generator import (
    A_COLUMNS,
    B_COLUMNS,
    _canonical_entities,
    _corrupt,
    generate_fixture,
)
from samewise_matcher.fixture_models import (
    CorruptionConfig,
    FixtureConfig,
    IdentityTruth,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def fixture_config(
    *, seed: int = 42, fixture_name: str = "test-organizations-v1"
) -> FixtureConfig:
    return FixtureConfig(
        fixture_name=fixture_name,
        seed=seed,
        canonical_entity_count=24,
        overlap_rate=0.70,
        a_only_rate=0.15,
        b_only_rate=0.15,
        duplicate_rows_a=2,
        duplicate_rows_b=1,
        hard_negative_pairs=3,
        corruption=CorruptionConfig.preset("moderate"),
    )


def generated(tmp_path: Path, *, seed: int = 42) -> tuple[Path, dict[str, object]]:
    root = tmp_path / f"run-{seed}"
    manifest = generate_fixture(fixture_config(seed=seed), root)
    return root, manifest


def read_csv(root: Path, relative_path: str) -> list[dict[str, str]]:
    with (root / relative_path).open(encoding="utf-8", newline="") as stream:
        return list(csv.DictReader(stream))


def read_json(root: Path, relative_path: str) -> object:
    return json.loads((root / relative_path).read_text(encoding="utf-8"))


def artifact_path(manifest: dict[str, object], key: str) -> str:
    artifacts = manifest["artifacts"]
    assert isinstance(artifacts, dict)
    artifact = artifacts[key]
    assert isinstance(artifact, dict)
    path = artifact["path"]
    assert isinstance(path, str)
    return path


def all_file_bytes(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def test_same_seed_produces_byte_identical_artifacts(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"

    generate_fixture(fixture_config(), first)
    generate_fixture(fixture_config(), second)

    assert all_file_bytes(first) == all_file_bytes(second)


def test_different_seeds_change_visible_records(tmp_path: Path) -> None:
    first_root, first_manifest = generated(tmp_path, seed=42)
    second_root, second_manifest = generated(tmp_path, seed=43)

    first_a = (first_root / artifact_path(first_manifest, "dataset_a")).read_bytes()
    second_a = (second_root / artifact_path(second_manifest, "dataset_a")).read_bytes()

    assert first_a != second_a


def test_visible_datasets_do_not_leak_truth_or_provenance(tmp_path: Path) -> None:
    root, manifest = generated(tmp_path)
    forbidden_columns = {
        "canonical_entity_id",
        "corruptions",
        "occurrence",
        "has_partner",
        "match_label",
    }

    for key in ("dataset_a", "dataset_b"):
        rows = read_csv(root, artifact_path(manifest, key))
        assert rows
        assert forbidden_columns.isdisjoint(rows[0])
        for row in rows:
            for value in row.values():
                lowered = value.lower()
                assert "entity_" not in lowered
                assert "canonical_entity" not in lowered
                assert "corruption" not in lowered


def test_source_ids_are_assigned_by_shuffled_source_position_not_canonical_id(
    tmp_path: Path,
) -> None:
    root, manifest = generated(tmp_path)
    a_rows = read_csv(root, artifact_path(manifest, "dataset_a"))
    b_rows = read_csv(root, artifact_path(manifest, "dataset_b"))
    truth = IdentityTruth.model_validate(
        read_json(root, artifact_path(manifest, "identity_truth"))
    )

    assert [row["vendor_id"] for row in a_rows] == [
        f"A{index:06d}" for index in range(1, len(a_rows) + 1)
    ]
    assert [row["organization_ref"] for row in b_rows] == [
        f"B{index:06d}" for index in range(1, len(b_rows) + 1)
    ]

    for source_rows in (truth.source_a, truth.source_b):
        primary_rows = [row for row in source_rows if row.occurrence == "primary"]
        assert any(
            int(row.source_row_id[1:])
            != int(row.canonical_entity_id.removeprefix("entity_"))
            for row in primary_rows
        )

    primary_a = {
        row.canonical_entity_id: row.source_row_id
        for row in truth.source_a
        if row.occurrence == "primary"
    }
    primary_b = {
        row.canonical_entity_id: row.source_row_id
        for row in truth.source_b
        if row.occurrence == "primary"
    }
    overlapping_ids = primary_a.keys() & primary_b.keys()
    assert any(
        int(primary_a[entity_id][1:]) != int(primary_b[entity_id][1:])
        for entity_id in overlapping_ids
    )


def test_corruption_never_mutates_canonical_model() -> None:
    config = fixture_config()
    canonical = _canonical_entities(config)[10]
    before = canonical.model_dump()

    _corrupt(
        canonical,
        "A",
        0,
        config,
        preserve_name=False,
        exact=False,
    )

    assert canonical.model_dump() == before


def test_requested_overlap_and_source_only_distribution_is_exact(
    tmp_path: Path,
) -> None:
    root, manifest = generated(tmp_path)
    truth_data = read_json(root, artifact_path(manifest, "identity_truth"))
    truth = IdentityTruth.model_validate(truth_data)
    a_entities = {row.canonical_entity_id for row in truth.source_a}
    b_entities = {row.canonical_entity_id for row in truth.source_b}
    counts = manifest["actual_counts"]
    assert isinstance(counts, dict)

    assert len(a_entities & b_entities) == counts["overlapping_entities"] == 17
    assert len(a_entities - b_entities) == counts["a_only_entities"] == 4
    assert len(b_entities - a_entities) == counts["b_only_entities"] == 3


def test_truth_resolves_same_and_different_pairs(tmp_path: Path) -> None:
    root, manifest = generated(tmp_path)
    truth = IdentityTruth.model_validate(
        read_json(root, artifact_path(manifest, "identity_truth"))
    )
    a_row = truth.source_a[0]
    same_b = next(
        row
        for row in truth.source_b
        if row.canonical_entity_id == a_row.canonical_entity_id
    )
    different_b = next(
        row
        for row in truth.source_b
        if row.canonical_entity_id != a_row.canonical_entity_id
    )

    assert truth.pair_is_same(a_row.source_row_id, same_b.source_row_id)
    assert not truth.pair_is_same(a_row.source_row_id, different_b.source_row_id)


def test_truth_represents_multiple_rows_for_one_entity(tmp_path: Path) -> None:
    root, manifest = generated(tmp_path)
    truth = IdentityTruth.model_validate(
        read_json(root, artifact_path(manifest, "identity_truth"))
    )
    duplicate = next(row for row in truth.source_a if row.occurrence == "duplicate")
    related_a = [
        row
        for row in truth.source_a
        if row.canonical_entity_id == duplicate.canonical_entity_id
    ]
    related_b = [
        row
        for row in truth.source_b
        if row.canonical_entity_id == duplicate.canonical_entity_id
    ]

    assert len(related_a) == 2
    if related_b:
        assert all(
            truth.pair_is_same(a.source_row_id, b.source_row_id)
            for a in related_a
            for b in related_b
        )


def test_hard_negatives_are_similar_but_canonically_distinct(tmp_path: Path) -> None:
    root, manifest = generated(tmp_path)
    hard_data = read_json(root, artifact_path(manifest, "hard_negatives"))
    canonical_lines = (
        (root / artifact_path(manifest, "canonical_entities"))
        .read_text(encoding="utf-8")
        .splitlines()
    )
    canonical = {
        item["canonical_entity_id"]: item
        for item in (json.loads(line) for line in canonical_lines)
    }
    assert isinstance(hard_data, dict)
    patterns = hard_data["patterns"]

    assert {item["pattern"] for item in patterns} == {
        "shared_name_tokens",
        "service_line_extension",
        "singular_related_service",
    }
    for item in patterns:
        left_id = item["left_canonical_entity_id"]
        right_id = item["right_canonical_entity_id"]
        assert left_id != right_id
        left_tokens = set(canonical[left_id]["organization_name"].lower().split())
        right_tokens = set(canonical[right_id]["organization_name"].lower().split())
        assert len(left_tokens & right_tokens) >= 2


def test_corruption_provenance_replays_to_generated_semantic_values(
    tmp_path: Path,
) -> None:
    root, manifest = generated(tmp_path)
    canonical = {
        item["canonical_entity_id"]: item
        for item in (
            json.loads(line)
            for line in (root / artifact_path(manifest, "canonical_entities"))
            .read_text(encoding="utf-8")
            .splitlines()
        )
    }
    provenance = [
        json.loads(line)
        for line in (root / artifact_path(manifest, "corruption_provenance"))
        .read_text(encoding="utf-8")
        .splitlines()
    ]
    a_rows = {
        row["vendor_id"]: row
        for row in read_csv(root, artifact_path(manifest, "dataset_a"))
    }
    b_rows = {
        row["organization_ref"]: row
        for row in read_csv(root, artifact_path(manifest, "dataset_b"))
    }
    mapping_data = read_json(root, artifact_path(manifest, "schema_mapping"))
    assert isinstance(mapping_data, dict)
    mappings = mapping_data["fields"]

    assert any(item["corruptions"] for item in provenance)
    for item in provenance:
        values = dict(canonical[item["canonical_entity_id"]])
        values.pop("canonical_entity_id")
        for event in item["corruptions"]:
            assert values[event["field"]] == event["before"]
            assert event["before"] != event["after"]
            values[event["field"]] = event["after"]
        visible = (
            a_rows[item["source_row_id"]]
            if item["source"] == "A"
            else b_rows[item["source_row_id"]]
        )
        for mapping in mappings:
            semantic = mapping["semantic_field"]
            if semantic == "source_row_id":
                continue
            column = (
                mapping["dataset_a_column"]
                if item["source"] == "A"
                else mapping["dataset_b_column"]
            )
            expected = values[semantic]
            if item["source"] == "A" and semantic == "website_domain":
                expected = f"https://{expected}"
            assert visible[column] == expected


def test_schema_mapping_references_visible_columns_only(tmp_path: Path) -> None:
    root, manifest = generated(tmp_path)
    mapping_data = read_json(root, artifact_path(manifest, "schema_mapping"))
    assert isinstance(mapping_data, dict)

    assert {field["dataset_a_column"] for field in mapping_data["fields"]} == set(
        A_COLUMNS
    )
    assert {field["dataset_b_column"] for field in mapping_data["fields"]} == set(
        B_COLUMNS
    )


@pytest.mark.parametrize(
    "overrides",
    [
        {"fixture_name": "../escape"},
        {"overlap_rate": 0.5, "a_only_rate": 0.3, "b_only_rate": 0.3},
        {
            "canonical_entity_count": 8,
            "overlap_rate": 0.5,
            "a_only_rate": 0.25,
            "b_only_rate": 0.25,
        },
        {"duplicate_rows_a": 999},
    ],
)
def test_impossible_configuration_fails_clearly(overrides: dict[str, object]) -> None:
    values = fixture_config().model_dump()
    values.update(overrides)

    with pytest.raises(ValidationError):
        FixtureConfig.model_validate(values)


def test_empty_values_use_empty_csv_cells_not_truthy_sentinels(tmp_path: Path) -> None:
    root, manifest = generated(tmp_path)
    rows = [
        *read_csv(root, artifact_path(manifest, "dataset_a")),
        *read_csv(root, artifact_path(manifest, "dataset_b")),
    ]
    forbidden = {"none", "null", "n/a", "missing", "unknown", "nan"}

    assert any(value == "" for row in rows for value in row.values())
    assert not any(value.lower() in forbidden for row in rows for value in row.values())


def test_manifest_hashes_every_declared_artifact(tmp_path: Path) -> None:
    root, manifest = generated(tmp_path)
    artifacts = manifest["artifacts"]
    assert isinstance(artifacts, dict)

    for artifact in artifacts.values():
        assert isinstance(artifact, dict)
        content = (root / artifact["path"]).read_bytes()
        assert hashlib.sha256(content).hexdigest() == artifact["sha256"]


def test_cli_generates_and_summarizes_fixture(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = tmp_path / "cli"
    args = [
        "fixtures",
        "generate",
        "--seed",
        "9",
        "--entities",
        "20",
        "--fixture",
        "cli-v1",
        "--output-root",
        str(root),
    ]

    assert main(args) == 0
    generated_output = json.loads(capsys.readouterr().out)
    assert generated_output["fixture_name"] == "cli-v1"
    assert (
        main(
            ["fixtures", "summarize", "--fixture", "cli-v1", "--output-root", str(root)]
        )
        == 0
    )
    summary = capsys.readouterr().out
    assert "Theoretical A × B pairs" in summary
    assert "precision" in summary.lower()
    assert "No matcher was run" in summary


def test_checked_in_development_fixture_is_current_and_has_required_cases(
    tmp_path: Path,
) -> None:
    fixture_name = "organizations-dev-v1"
    benchmark_root = REPOSITORY_ROOT / "evaluation" / "benchmarks" / fixture_name
    checked_manifest = json.loads(
        (benchmark_root / "manifest.json").read_text(encoding="utf-8")
    )
    checked_config = FixtureConfig.model_validate_json(
        (benchmark_root / "config.json").read_text(encoding="utf-8")
    )
    regenerated_root = tmp_path / "regenerated"
    regenerated_manifest = generate_fixture(checked_config, regenerated_root)

    assert regenerated_manifest == checked_manifest
    for artifact in checked_manifest["artifacts"].values():
        relative_path = artifact["path"]
        assert (regenerated_root / relative_path).read_bytes() == (
            REPOSITORY_ROOT / relative_path
        ).read_bytes()

    truth = IdentityTruth.model_validate(
        read_json(REPOSITORY_ROOT, artifact_path(checked_manifest, "identity_truth"))
    )
    a_rows = {
        row["vendor_id"]: row
        for row in read_csv(
            REPOSITORY_ROOT, artifact_path(checked_manifest, "dataset_a")
        )
    }
    b_rows = {
        row["organization_ref"]: row
        for row in read_csv(
            REPOSITORY_ROOT, artifact_path(checked_manifest, "dataset_b")
        )
    }
    b_by_entity = {
        row.canonical_entity_id: b_rows[row.source_row_id] for row in truth.source_b
    }
    true_visible_pairs = [
        (a_rows[a_row.source_row_id], b_by_entity[a_row.canonical_entity_id])
        for a_row in truth.source_a
        if a_row.canonical_entity_id in b_by_entity
    ]

    assert any(a["vendor_name"] == b["organization"] for a, b in true_visible_pairs)
    assert any(a["vendor_name"] != b["organization"] for a, b in true_visible_pairs)
    assert any(
        a["account_status"] != b["status"] or a["balance"] != b["outstanding_balance"]
        for a, b in true_visible_pairs
    )
    assert any(
        value == ""
        for row in [*a_rows.values(), *b_rows.values()]
        for value in row.values()
    )
    assert any(row.occurrence == "duplicate" for row in truth.source_a)
    assert any(row.occurrence == "duplicate" for row in truth.source_b)
    a_entities = {row.canonical_entity_id for row in truth.source_a}
    b_entities = {row.canonical_entity_id for row in truth.source_b}
    assert a_entities - b_entities
    assert b_entities - a_entities
