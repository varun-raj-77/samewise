from copy import deepcopy
from pathlib import Path

import pytest

import samewise_matcher.baseline as baseline
from samewise_matcher.baseline import match_csvs
from samewise_matcher.candidate_engine import (
    CandidateEngineConfig,
    generate_candidates,
)
from samewise_matcher.workflow_models import ManualMapping


def mapping(
    mapping_id: str,
    a_column: str,
    b_column: str,
    normalizer: str = "text",
    role: str = "identity",
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


def generate(
    a_rows: list[dict[str, str]],
    b_rows: list[dict[str, str]],
    mappings: list[ManualMapping],
    config: CandidateEngineConfig | None = None,
):
    return generate_candidates(
        list(a_rows[0]), a_rows, list(b_rows[0]), b_rows, mappings, config
    )


def pairs(result) -> set[tuple[str, str]]:
    return {(item.aRowId, item.bRowId) for item in result.candidates}


def test_exact_phone_and_email_union_and_retain_all_provenance() -> None:
    a = [{"id": "A1", "phone": "(555) 010-1000", "email": "x@example.com"}]
    b = [{"id": "B1", "phone": "+1 555 010 1000", "email": "X@example.com"}]
    result = generate(
        a,
        b,
        [
            mapping("phone", "phone", "phone", "phone"),
            mapping("email", "email", "email", "email"),
        ],
    )
    assert pairs(result) == {("A1", "B1")}
    evidence = result.candidates[0].blockingEvidence
    assert {item.blockerId for item in evidence} == {"exact_strong_v1"}
    assert len(evidence) == 3


def test_name_variation_and_location_name_are_independent_recovery_paths() -> None:
    mappings = [
        mapping("organization-name", "name", "organization"),
        mapping("city", "city", "locality"),
    ]
    a = [{"id": "A1", "name": "Northstar Medical Inc", "city": "Boston"}]
    b = [{"id": "B1", "organization": "Northstar Medcial", "locality": "BOSTON"}]
    result = generate(a, b, mappings)
    blockers = {item.blockerId for item in result.candidates[0].blockingEvidence}
    assert "name_token_v1" in blockers
    assert "location_name_v2" in blockers


def test_v2_compact_name_context_recovers_spacing_without_broad_bucket() -> None:
    mappings = [
        mapping("organization-name", "name", "organization"),
        mapping("city", "city", "locality"),
        mapping("address", "street", "address"),
    ]
    a = [
        {
            "id": "A1",
            "name": "SummitPackaging LLC",
            "city": "Albany",
            "street": "4522 Market Street",
        }
    ]
    b = [
        {
            "id": "B1",
            "organization": "Summit Packaging LLC",
            "locality": "Albany",
            "address": "4522 Market St",
        }
    ]
    old = CandidateEngineConfig(
        engineVersion="candidate-engine-v0.1.0",
        enabledBlockers=("location_name_v1", "address_name_v1"),
    )
    new = CandidateEngineConfig(enabledBlockers=("location_name_v2", "address_name_v2"))
    assert generate(a, b, mappings, old).candidates == []
    old_result = generate(a, b, mappings, old)
    assert old_result.engineVersion == "candidate-engine-v0.1.0"
    new_result = generate(a, b, mappings, new)
    assert new_result.engineVersion == "candidate-engine-v0.4.0"
    blockers = {
        evidence.blockerId for evidence in new_result.candidates[0].blockingEvidence
    }
    assert blockers == {"location_name_v2", "address_name_v2"}


def test_address_name_block_uses_conservative_house_number_and_name_token() -> None:
    config = CandidateEngineConfig(enabledBlockers=("address_name_v1",))
    mappings = [
        mapping("organization-name", "name", "organization"),
        mapping("address", "street", "address"),
    ]
    a = [{"id": "A1", "name": "Harbor Medical", "street": "10 Main Street"}]
    b = [{"id": "B1", "organization": "Harbor Medcial", "address": "10 Main St"}]
    assert pairs(generate(a, b, mappings, config)) == {("A1", "B1")}


def test_empty_strong_values_never_form_keys_or_candidates() -> None:
    config = CandidateEngineConfig(enabledBlockers=("exact_strong_v1",))
    item = mapping("email", "email", "email", "email")
    result = generate(
        [{"id": "A1", "email": ""}],
        [{"id": "B1", "email": ""}],
        [item],
        config,
    )
    assert result.candidates == []


def test_equal_generic_identity_value_generates_mapping_specific_exact_candidate() -> (
    None
):
    item = mapping("stable-id", "stable_id", "stable_id")
    result = generate(
        [{"record_id": "A-IV-701", "stable_id": "VEND-7001"}],
        [{"record_id": "B-IV-301", "stable_id": "vend 7001"}],
        [item],
    )
    assert pairs(result) == {("A-IV-701", "B-IV-301")}
    assert [item.blockerId for item in result.candidates[0].blockingEvidence] == [
        "exact_strong_v1"
    ]


def test_different_generic_identity_values_do_not_generate_candidate() -> None:
    item = mapping("stable-id", "stable_id", "stable_id")
    result = generate(
        [{"id": "A1", "stable_id": "VEND-7001"}],
        [{"id": "B1", "stable_id": "VEND-7002"}],
        [item],
    )
    assert result.candidates == []


@pytest.mark.parametrize(("left", "right"), [("", ""), ("   ", "\t")])
def test_missing_or_blank_generic_identity_values_do_not_generate_candidate(
    left: str, right: str
) -> None:
    item = mapping("stable-id", "stable_id", "stable_id")
    result = generate(
        [{"id": "A1", "stable_id": left}],
        [{"id": "B1", "stable_id": right}],
        [item],
    )
    assert result.candidates == []


def test_generic_exact_keys_do_not_collide_across_unrelated_mappings() -> None:
    mappings = [
        mapping("generic-one", "left_one", "right_one"),
        mapping("generic-two", "left_two", "right_two"),
    ]
    result = generate(
        [{"id": "A1", "left_one": "shared", "left_two": "left-only"}],
        [{"id": "B1", "right_one": "right-only", "right_two": "shared"}],
        mappings,
    )
    assert result.candidates == []


def test_generic_comparison_mapping_does_not_generate_identity_candidate() -> None:
    mappings = [
        mapping("stable-id", "stable_id", "stable_id"),
        mapping("comparison-code", "code", "code", role="comparison"),
    ]
    result = generate(
        [{"id": "A1", "stable_id": "left", "code": "shared"}],
        [{"id": "B1", "stable_id": "right", "code": "shared"}],
        mappings,
    )
    assert result.candidates == []


def test_recognized_blockers_are_unchanged_in_v3() -> None:
    mappings = [
        mapping("phone", "phone", "phone", "phone"),
        mapping("organization-name", "name", "name"),
    ]
    a = [{"id": "A1", "phone": "555-010-1000", "name": "Acme Medical"}]
    b = [{"id": "B1", "phone": "5550101000", "name": "Acme Medcial"}]
    old = generate(
        a,
        b,
        mappings,
        CandidateEngineConfig(engineVersion="candidate-engine-v0.2.0"),
    )
    new = generate(a, b, mappings)
    assert pairs(old) == pairs(new) == {("A1", "B1")}
    assert old.candidates[0].blockingEvidence == new.candidates[0].blockingEvidence
    assert old.blockerDiagnostics == new.blockerDiagnostics


def test_generic_exact_bucket_uses_existing_whole_bucket_suppression() -> None:
    config = CandidateEngineConfig(
        enabledBlockers=("exact_strong_v1",),
        maxBucketSizePerSide=2,
        maxBucketPairCount=100,
    )
    item = mapping("stable-id", "stable_id", "stable_id")
    a = [{"id": f"A{i}", "stable_id": "shared"} for i in range(3)]
    b = [{"id": f"B{i}", "stable_id": "shared"} for i in range(3)]
    result = generate(a, b, [item], config)
    assert result.candidates == []
    assert result.blockerDiagnostics[0].keysSuppressed == 1


def test_semantic_identifier_and_contact_routes_are_generic() -> None:
    persistent = ManualMapping(
        mappingId="durable-key",
        label="Durable key",
        aColumn="tax_number",
        bColumn="registration_number",
        role="identity",
        normalizer="text",
        semanticFamily="persistent_identifier",
    )
    contact = ManualMapping(
        mappingId="representative",
        label="Representative",
        aColumn="representative",
        bColumn="account_owner",
        role="identity",
        normalizer="text",
        semanticFamily="contact_person",
    )
    geography = ManualMapping(
        mappingId="area",
        label="Area",
        aColumn="region_name",
        bColumn="area_name",
        role="identity",
        normalizer="text",
        semanticFamily="geography",
    )
    rows_a = [
        {
            "id": "A1",
            "tax_number": "TX-42",
            "representative": "Alex Morgan",
            "region_name": "North",
        }
    ]
    rows_b = [
        {
            "id": "B1",
            "registration_number": "tx 42",
            "account_owner": "Alex Morgan",
            "area_name": "North",
        }
    ]
    result = generate(rows_a, rows_b, [persistent, contact, geography])
    assert pairs(result) == {("A1", "B1")}
    blockers = {item.blockerId for item in result.candidates[0].blockingEvidence}
    assert blockers == {"persistent_exact_v1", "supporting_context_v1"}


def test_source_local_identifiers_do_not_get_fuzzy_candidate_routes() -> None:
    source_local = ManualMapping(
        mappingId="local-row-key",
        label="Local row key",
        aColumn="row_key",
        bColumn="source_pk",
        role="identity",
        normalizer="text",
        semanticFamily="source_local_identifier",
    )
    result = generate(
        [{"id": "A1", "row_key": "A-0001"}],
        [{"id": "B1", "source_pk": "A-0002"}],
        [source_local],
    )
    assert result.candidates == []
    assert all(item.relationshipsGenerated == 0 for item in result.blockerDiagnostics)


def test_v2_does_not_claim_v3_generic_exact_membership_semantics() -> None:
    config = CandidateEngineConfig(
        engineVersion="candidate-engine-v0.2.0",
        enabledBlockers=("exact_strong_v1",),
    )
    item = mapping("stable-id", "stable_id", "stable_id")
    result = generate(
        [{"id": "A1", "stable_id": "VEND-7001"}],
        [{"id": "B1", "stable_id": "VEND-7001"}],
        [item],
        config,
    )
    assert result.candidates == []


def test_oversized_common_bucket_is_suppressed_and_measured_not_truncated() -> None:
    config = CandidateEngineConfig(
        enabledBlockers=("name_token_v1",),
        stopTokens=(),
        maxBucketSizePerSide=2,
        maxBucketPairCount=100,
    )
    item = mapping("organization-name", "name", "name")
    a = [{"id": f"A{i}", "name": "Common Alpha"} for i in range(3)]
    b = [{"id": f"B{i}", "name": "Common Beta"} for i in range(3)]
    result = generate(a, b, [item], config)
    diagnostic = result.blockerDiagnostics[0]
    assert result.candidates == []
    assert diagnostic.keysSuppressed == 1
    assert diagnostic.relationshipsSuppressed == 9


def test_adversarial_null_duplicate_long_unicode_bucket_cannot_explode() -> None:
    config = CandidateEngineConfig(
        enabledBlockers=("name_token_v1", "exact_strong_v1"),
        stopTokens=(),
        maxBucketSizePerSide=20,
        maxBucketPairCount=100,
    )
    mappings = [
        mapping("organization-name", "name", "name"),
        mapping("phone", "phone", "phone", "phone"),
    ]
    long_name = f"München {'Å' * 2_000} Common"
    a = [{"id": f"A{i}", "name": long_name, "phone": ""} for i in range(25)]
    b = [{"id": f"B{i}", "name": long_name, "phone": ""} for i in range(25)]
    result = generate(a, b, mappings, config)
    assert result.candidates == []
    assert (
        sum(item.relationshipsSuppressed for item in result.blockerDiagnostics) == 1_875
    )
    assert sum(item.keysSuppressed for item in result.blockerDiagnostics) == 3


def test_duplicates_and_one_to_many_possibilities_are_preserved() -> None:
    config = CandidateEngineConfig(enabledBlockers=("exact_strong_v1",))
    item = mapping("phone", "phone", "phone", "phone")
    a = [
        {"id": "A1", "phone": "5550101000"},
        {"id": "A2", "phone": "5550101000"},
    ]
    b = [
        {"id": "B1", "phone": "5550101000"},
        {"id": "B2", "phone": "5550101000"},
    ]
    assert pairs(generate(a, b, [item], config)) == {
        ("A1", "B1"),
        ("A1", "B2"),
        ("A2", "B1"),
        ("A2", "B2"),
    }


def test_generation_is_deterministic_truth_blind_and_does_not_mutate_rows() -> None:
    item = mapping("organization-name", "name", "name")
    a = [{"id": "A1", "name": "Acme Incorporated"}]
    b = [{"id": "B1", "name": "ACME Inc"}]
    before = deepcopy((a, b))
    first = generate(a, b, [item])
    second = generate(a, b, [item])
    assert first == second
    assert (a, b) == before
    assert all(candidate.aRowId == "A1" for candidate in first.candidates)
    assert all(candidate.bRowId == "B1" for candidate in first.candidates)


def test_stage_timing_does_not_change_candidate_membership_or_order() -> None:
    item = mapping("organization-name", "name", "name")
    a = [{"id": "A1", "name": "Acme Incorporated"}]
    b = [{"id": "B1", "name": "ACME Inc"}]
    expected = generate(a, b, [item])
    timings: dict[str, float] = {}
    measured = generate_candidates(
        list(a[0]),
        a,
        list(b[0]),
        b,
        [item],
        performance_timings=timings,
    )
    assert measured == expected
    assert set(timings) == {
        "normalization_index_construction_seconds",
        "candidate_generation_seconds",
    }


def test_candidate_mode_scores_only_generated_pairs_and_matches_oracle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    a_path = tmp_path / "a.csv"
    b_path = tmp_path / "b.csv"
    a_path.write_text("id,phone\nA1,5550101000\n", encoding="utf-8")
    b_path.write_text(
        "id,phone\nB1,5550101000\nB2,5550102000\nB3,5550103000\n",
        encoding="utf-8",
    )
    item = mapping("phone", "phone", "phone", "phone")
    oracle = match_csvs(a_path, b_path, [item], candidate_mode="all_pairs")
    original = baseline.compare_field
    calls = 0

    def counted(*args, **kwargs):
        nonlocal calls
        calls += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(baseline, "compare_field", counted)
    blocked = match_csvs(a_path, b_path, [item], candidate_mode="candidate_engine")
    assert calls == 1
    assert blocked.candidates[0].matchScore == oracle.candidates[0].matchScore
    assert blocked.candidates[0].evidence == oracle.candidates[0].evidence
