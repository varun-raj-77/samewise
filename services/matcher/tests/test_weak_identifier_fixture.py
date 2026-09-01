import inspect
import json
from pathlib import Path

import samewise_matcher.weak_identifier_fixture as weak_fixture_module
from samewise_matcher.fixture_models import CorruptionConfig, FixtureConfig
from samewise_matcher.weak_identifier_fixture import (
    WeakIdentifierFixtureConfig,
    WeakIdentifierPolicy,
    generate_weak_identifier_fixture,
)


def config() -> WeakIdentifierFixtureConfig:
    return WeakIdentifierFixtureConfig(
        baseFixture=FixtureConfig(
            fixture_name="weak-test-v1",
            seed=123,
            canonical_entity_count=20,
            overlap_rate=0.7,
            a_only_rate=0.15,
            b_only_rate=0.15,
            duplicate_rows_a=2,
            duplicate_rows_b=2,
            hard_negative_pairs=3,
            corruption=CorruptionConfig.preset("moderate"),
        ),
        weakIdentifierPolicy=WeakIdentifierPolicy(seed=456),
    )


def test_weak_identifier_policy_is_row_local_and_does_not_select_by_truth() -> None:
    source = inspect.getsource(weak_fixture_module)
    assert "canonical_entity_id" not in source
    assert "identity_truth" not in source
    assert "hard_negative" not in source


def test_weak_identifier_fixture_is_deterministic_and_versioned(
    tmp_path: Path,
) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first_manifest = generate_weak_identifier_fixture(config(), first)
    second_manifest = generate_weak_identifier_fixture(config(), second)
    assert first_manifest == second_manifest
    assert first_manifest["generator_version"] == (
        "weak-identifier-fixture-generator-v0.1.0"
    )
    assert first_manifest["base_generator_version"] == "fixture-generator-v0.1.0"
    for artifact in first_manifest["artifacts"].values():
        relative = artifact["path"]
        assert (first / relative).read_bytes() == (second / relative).read_bytes()

    provenance_path = (
        first / first_manifest["artifacts"]["corruption_provenance"]["path"]
    )
    strategies = {
        event["strategy"]
        for line in provenance_path.read_text(encoding="utf-8").splitlines()
        for event in json.loads(line)["corruptions"]
    }
    assert "weak_policy_missing" in strategies
    assert "weak_policy_stale" in strategies
