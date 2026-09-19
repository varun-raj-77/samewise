import math
from pathlib import Path

import pytest

from samewise_matcher.candidate_engine import CandidateEngineConfig, GeneratedCandidate
from samewise_matcher.explainable_matcher import (
    MatcherConfig,
    build_match_result,
    compute_field_evidence,
    match_csvs_explainable,
    score_candidate,
    score_generated_candidates,
)
from samewise_matcher.workflow_models import BlockingEvidenceView, ManualMapping


def mapping(
    mapping_id: str,
    *,
    role: str = "identity",
    normalizer: str = "text",
) -> ManualMapping:
    return ManualMapping.model_validate(
        {
            "mappingId": mapping_id,
            "label": mapping_id.replace("-", " "),
            "aColumn": mapping_id,
            "bColumn": mapping_id,
            "role": role,
            "normalizer": normalizer,
        }
    )


BLOCKING = [BlockingEvidenceView(blockerId="name_token_v1", keyHash="0123456789abcdef")]


def test_default_product_config_matches_frozen_versioned_file() -> None:
    root = Path(__file__).resolve().parents[3]
    frozen = MatcherConfig.model_validate_json(
        (root / "evaluation/configs/matcher-v0.3.0-candidate-v0.4.0.json").read_text()
    )
    assert MatcherConfig() == frozen
    assert frozen.frozen
    assert frozen.tunedOnFixture is None


def semantic_mapping(
    mapping_id: str, family: str, normalizer: str = "text"
) -> ManualMapping:
    return ManualMapping(
        mappingId=mapping_id,
        label=mapping_id.replace("-", " "),
        aColumn=mapping_id,
        bColumn=mapping_id,
        role="identity",
        normalizer=normalizer,
        semanticFamily=family,
    )


def test_persistent_identifier_is_exact_only_and_strongly_contradictory() -> None:
    item = semantic_mapping("supplier-key", "persistent_identifier")
    exact = compute_field_evidence(item, "VEND-107004", "vend 107004", MatcherConfig())
    different = compute_field_evidence(
        item, "VEND-107004", "VEND-120962", MatcherConfig()
    )
    assert exact.evidenceClass == "exact_agreement"
    assert different.evidenceClass == "conflict"
    assert different.positiveContribution == 0
    assert all(feature.name != "character_similarity" for feature in different.features)
    pair = score_candidate(
        "A1",
        "B1",
        {"supplier-key": "VEND-107004"},
        {"supplier-key": "VEND-120962"},
        [item],
        BLOCKING,
        MatcherConfig(),
    )
    assert pair.strongContradiction


def test_contact_person_is_distinct_from_entity_name_semantics() -> None:
    entity = semantic_mapping("display-title", "name_or_title")
    contact = semantic_mapping("representative", "contact_person")
    assert (
        compute_field_evidence(
            entity, "Acme Works", "Acme Work", MatcherConfig()
        ).fieldKind
        == "name_or_title"
    )
    evidence = compute_field_evidence(
        contact, "Alex Morgan", "Alex Morgn", MatcherConfig()
    )
    assert evidence.fieldKind == "contact_person"
    assert (
        evidence.weight
        < compute_field_evidence(
            entity, "Acme Works", "Acme Work", MatcherConfig()
        ).weight
    )


def test_unknown_semantics_use_conservative_exact_comparison() -> None:
    item = semantic_mapping("opaque-value", "unknown")
    evidence = compute_field_evidence(item, "ABC-100", "ABC-101", MatcherConfig())
    assert evidence.evidenceClass == "conflict"
    assert evidence.positiveContribution == 0


def test_domain_semantics_normalize_hosts_and_remain_exact() -> None:
    item = semantic_mapping("website", "domain")
    exact = compute_field_evidence(
        item, "https://www.example.com/about", "example.com", MatcherConfig()
    )
    different = compute_field_evidence(
        item, "example.com", "example.net", MatcherConfig()
    )
    assert exact.evidenceClass == "exact_agreement"
    assert different.evidenceClass == "conflict"
    assert different.positiveContribution == 0


@pytest.mark.parametrize(
    ("item", "left", "right", "feature"),
    [
        (
            mapping("phone", normalizer="phone"),
            "+1 555-010-1000",
            "5550101000",
            "normalized_exact",
        ),
        (
            mapping("email", normalizer="email"),
            "A@Example.com",
            "a@example.com",
            "normalized_exact",
        ),
        (
            mapping("website-domain"),
            "https://www.acme.com/path",
            "acme.com",
            "normalized_host_exact",
        ),
        (mapping("city"), "New York", "new york", "normalized_exact"),
        (mapping("region"), "NY", "ny", "normalized_exact"),
        (mapping("postal"), "10001-1234", "10001", "normalized_exact"),
    ],
)
def test_exact_strong_and_location_features_are_explicit(
    item: ManualMapping, left: str, right: str, feature: str
) -> None:
    evidence = compute_field_evidence(item, left, right, MatcherConfig())
    assert evidence.evidenceClass == "exact_agreement"
    assert any(
        value.name == feature and value.value == 1 for value in evidence.features
    )
    assert evidence.positiveContribution > 0


def test_name_features_cover_fuzzy_reorder_and_corporate_suffix_variation() -> None:
    item = mapping("organization-name")
    reorder = compute_field_evidence(
        item,
        "Northstar Industrial Solutions LLC",
        "Industrial Northstar Solutions",
        MatcherConfig(),
    )
    suffix = compute_field_evidence(
        item, "Acme Incorporated", "ACME Inc.", MatcherConfig()
    )
    assert reorder.evidenceClass == "partial_agreement"
    assert (
        next(
            feature.value
            for feature in reorder.features
            if feature.name == "token_similarity"
        )
        == 1
    )
    assert suffix.evidenceClass == "exact_agreement"


def test_address_partial_agreement_exposes_number_tokens_and_character_similarity() -> (
    None
):
    evidence = compute_field_evidence(
        mapping("street-address"),
        "120 North Main Street",
        "120 N Main St.",
        MatcherConfig(),
    )
    values = {feature.name: feature.value for feature in evidence.features}
    assert values["house_number_exact"] == 1
    assert values["token_similarity"] > 0
    assert values["character_similarity"] > 0
    assert evidence.evidenceClass == "partial_agreement"


@pytest.mark.parametrize(
    ("item", "left", "right"),
    [
        (mapping("phone", normalizer="phone"), "5550101000", "5559999999"),
        (mapping("email", normalizer="email"), "a@one.com", "b@two.com"),
        (mapping("website-domain"), "one.com", "two.com"),
    ],
)
def test_strong_nonempty_conflicts_are_negative_and_inspectable(
    item: ManualMapping, left: str, right: str
) -> None:
    evidence = compute_field_evidence(item, left, right, MatcherConfig())
    assert evidence.evidenceClass == "conflict"
    assert evidence.conflictContribution > 0
    assert evidence.contribution < evidence.positiveContribution


def test_missing_left_right_and_both_are_neutral_and_bounded() -> None:
    item = mapping("organization-name")
    cases = [
        ("", "Acme", "missing_left"),
        ("Acme", "", "missing_right"),
        ("", "", "missing_both"),
    ]
    for left, right, expected in cases:
        evidence = compute_field_evidence(item, left, right, MatcherConfig())
        assert evidence.evidenceClass == expected
        assert evidence.contribution == 0
        assert evidence.features == []
    values = compute_field_evidence(
        item, "Acme North", "North Acme", MatcherConfig()
    ).features
    assert all(0 <= feature.value <= 1 for feature in values)


def test_comparison_mapping_is_rejected_by_identity_pipeline() -> None:
    with pytest.raises(ValueError, match="Comparison mappings cannot enter"):
        compute_field_evidence(
            mapping("status", role="comparison"), "active", "inactive", MatcherConfig()
        )


def test_score_trace_reconciles_and_missing_cannot_inflate() -> None:
    mappings = [mapping("organization-name"), mapping("phone", normalizer="phone")]
    complete = score_candidate(
        "A1",
        "B1",
        {"organization-name": "Acme Inc", "phone": "5550101000"},
        {"organization-name": "Acme", "phone": "5550101000"},
        mappings,
        BLOCKING,
        MatcherConfig(),
    )
    missing = score_candidate(
        "A1",
        "B1",
        {"organization-name": "Acme Inc", "phone": ""},
        {"organization-name": "Acme", "phone": ""},
        mappings,
        BLOCKING,
        MatcherConfig(),
    )
    assert missing.matchScore <= complete.matchScore
    assert complete.matchScore == round(
        max(0, complete.positiveEvidence - complete.conflictEvidence)
        / complete.totalWeight,
        6,
    )
    assert math.isfinite(complete.matchScore)
    assert 0 <= complete.matchScore <= 1


def test_all_missing_identity_evidence_cannot_create_high_match() -> None:
    result = score_candidate(
        "A1",
        "B1",
        {"organization-name": "", "phone": ""},
        {"organization-name": "", "phone": ""},
        [mapping("organization-name"), mapping("phone", normalizer="phone")],
        BLOCKING,
        MatcherConfig(),
    )
    assert result.matchScore == 0
    assert result.agreementFields == 0


def test_strong_multi_field_agreement_beats_weak_and_hard_negative() -> None:
    mappings = [
        mapping("organization-name"),
        mapping("phone", normalizer="phone"),
        mapping("street-address"),
    ]
    left = {
        "organization-name": "Northstar Services",
        "phone": "5550101000",
        "street-address": "10 Main St",
    }
    true = {
        "organization-name": "Northstar Service",
        "phone": "5550101000",
        "street-address": "10 Main Street",
    }
    hard = {
        "organization-name": "Northstar Services Group",
        "phone": "5559999999",
        "street-address": "900 Other Road",
    }
    true_score = score_candidate(
        "A1", "B1", left, true, mappings, BLOCKING, MatcherConfig()
    )
    hard_score = score_candidate(
        "A1", "B2", left, hard, mappings, BLOCKING, MatcherConfig()
    )
    assert true_score.matchScore > hard_score.matchScore
    phone_conflict = next(
        item for item in hard_score.evidence if item.mappingId == "phone"
    )
    assert phone_conflict.evidenceClass == "conflict"
    assert phone_conflict.conflictContribution > 0


def test_same_name_different_phone_never_auto_matches(tmp_path: Path) -> None:
    a_path, b_path = tmp_path / "a.csv", tmp_path / "b.csv"
    _write(a_path, "id,name,phone\nA1,Varun,2165551111\n")
    _write(b_path, "id,name,phone\nB1,Varun,4405559999\n")
    result = match_csvs_explainable(
        a_path,
        b_path,
        [mapping("name"), mapping("phone", normalizer="phone")],
        candidate_mode="all_pairs",
    )
    assert len(result.candidates) == 1
    candidate = result.candidates[0]
    assert candidate.band == "needs_review"
    phone = next(item for item in candidate.evidence if item.mappingId == "phone")
    assert phone.evidenceClass == "conflict"
    assert phone.conflictContribution > 0


def test_multi_field_agreement_keeps_phone_contradiction_visible(
    tmp_path: Path,
) -> None:
    a_path, b_path = tmp_path / "a.csv", tmp_path / "b.csv"
    _write(
        a_path,
        "id,name,phone,email,address\n"
        "A1,Varun,2165551111,varun@example.com,123 Main St\n",
    )
    _write(
        b_path,
        "id,name,phone,email,address\n"
        "B1,Varun,4405559999,varun@example.com,123 Main Street\n",
    )
    result = match_csvs_explainable(
        a_path,
        b_path,
        [
            mapping("name"),
            mapping("phone", normalizer="phone"),
            mapping("email", normalizer="email"),
            mapping("address"),
        ],
        candidate_mode="all_pairs",
    )
    candidate = result.candidates[0]
    assert candidate.band == "auto_match"
    assert not candidate.strongContradiction
    phone = next(item for item in candidate.evidence if item.mappingId == "phone")
    assert phone.conflictContribution > 0


def _write(path: Path, value: str) -> None:
    path.write_text(value, encoding="utf-8")


def test_runtime_uses_only_identity_mappings_and_preserves_source_order_invariance(
    tmp_path: Path,
) -> None:
    a_path, b_path = tmp_path / "a.csv", tmp_path / "b.csv"
    _write(a_path, "id,organization-name,status\nA1,Acme,active\n")
    _write(b_path, "id,organization-name,status\nB2,Other,inactive\nB1,Acme,inactive\n")
    mappings = [mapping("organization-name"), mapping("status", role="comparison")]
    first = match_csvs_explainable(a_path, b_path, mappings, candidate_mode="all_pairs")
    _write(b_path, "id,organization-name,status\nB1,Acme,changed\nB2,Other,changed\n")
    second = match_csvs_explainable(
        a_path, b_path, mappings, candidate_mode="all_pairs"
    )
    assert first.candidates[0].bRowId == second.candidates[0].bRowId == "B1"
    assert first.candidates[0].matchScore == second.candidates[0].matchScore
    assert [item.mappingId for item in first.candidates[0].evidence] == [
        "organization-name"
    ]


def test_decision_rules_route_margin_collision_contradiction_review_and_unmatched() -> (
    None
):
    item = mapping("organization-name")
    config = MatcherConfig().model_copy(
        update={
            "decisions": MatcherConfig().decisions.model_copy(
                update={"minimumAutoAgreementFields": 1}
            )
        }
    )
    base = score_candidate(
        "A1",
        "B1",
        {"organization-name": "Acme"},
        {"organization-name": "Acme"},
        [item],
        BLOCKING,
        MatcherConfig(),
    )
    close = base.model_copy(update={"bRowId": "B2", "matchScore": 0.99})
    ambiguous = build_match_result(
        ["id", "organization-name"],
        [{"id": "A1", "organization-name": "Acme"}],
        ["id", "organization-name"],
        [
            {"id": "B1", "organization-name": "Acme"},
            {"id": "B2", "organization-name": "Acme"},
        ],
        [base, close],
        config,
    )
    assert ambiguous.candidates[0].band == "needs_review"

    collision_pairs = [
        base,
        base.model_copy(update={"aRowId": "A2"}),
    ]
    collision = build_match_result(
        ["id", "organization-name"],
        [
            {"id": "A1", "organization-name": "Acme"},
            {"id": "A2", "organization-name": "Acme"},
        ],
        ["id", "organization-name"],
        [{"id": "B1", "organization-name": "Acme"}],
        collision_pairs,
        config,
    )
    assert all(
        item.collision and item.band == "needs_review" for item in collision.candidates
    )

    contradiction = base.model_copy(update={"strongContradiction": True})
    contradicted = build_match_result(
        ["id", "organization-name"],
        [{"id": "A1", "organization-name": "Acme"}],
        ["id", "organization-name"],
        [{"id": "B1", "organization-name": "Acme"}],
        [contradiction],
        config,
    )
    assert contradicted.candidates[0].band == "needs_review"

    below = base.model_copy(update={"matchScore": 0.1})
    unmatched = build_match_result(
        ["id", "organization-name"],
        [{"id": "A1", "organization-name": "Acme"}],
        ["id", "organization-name"],
        [{"id": "B1", "organization-name": "Acme"}],
        [below],
        config,
    )
    assert unmatched.candidates == []
    assert unmatched.onlyA[0]["rowId"] == "A1"


def test_output_is_deterministic_and_candidate_provenance_survives() -> None:
    item = mapping("organization-name")
    pair = score_candidate(
        "A1",
        "B1",
        {"organization-name": "Acme"},
        {"organization-name": "Acme"},
        [item],
        BLOCKING,
        MatcherConfig(),
    )
    again = score_candidate(
        "A1",
        "B1",
        {"organization-name": "Acme"},
        {"organization-name": "Acme"},
        [item],
        BLOCKING,
        MatcherConfig(),
    )
    assert pair == again
    assert pair.blockingEvidence == BLOCKING


def test_cached_row_normalization_preserves_uncached_score_evidence() -> None:
    mappings = [mapping("organization-name"), mapping("email", normalizer="email")]
    a_row = {"organization-name": "Acme, Inc.", "email": "INFO@EXAMPLE.COM"}
    b_row = {"organization-name": "Acme Incorporated", "email": "info@example.com"}
    expected = score_candidate(
        "A1", "B1", a_row, b_row, mappings, BLOCKING, MatcherConfig()
    )
    candidate = GeneratedCandidate(
        candidateId="candidate-0123456789abcdef0123",
        aRowId="A1",
        bRowId="B1",
        blockingEvidence=[item.model_dump() for item in BLOCKING],
    )
    timings: dict[str, float] = {}
    actual = score_generated_candidates(
        [candidate],
        {"A1": a_row},
        {"B1": b_row},
        mappings,
        MatcherConfig(),
        performance_timings=timings,
    )
    assert actual == [expected]
    assert set(timings) == {
        "feature_normalization_cache_seconds",
        "feature_extraction_seconds",
        "scoring_seconds",
    }


def test_single_generic_identity_exact_match_routes_to_review_not_source_only(
    tmp_path: Path,
) -> None:
    a_path, b_path = tmp_path / "a.csv", tmp_path / "b.csv"
    _write(a_path, "record_id,stable_id\nA-IV-701,VEND-7001\n")
    _write(b_path, "record_id,stable_id\nB-IV-301,VEND-7001\n")

    stable_id = ManualMapping(
        mappingId="stable-id",
        label="Stable ID",
        aColumn="stable_id",
        bColumn="stable_id",
        role="identity",
        normalizer="text",
    )
    result = match_csvs_explainable(a_path, b_path, [stable_id])

    assert result.onlyA == []
    assert len(result.candidates) == 1
    candidate = result.candidates[0]
    assert (candidate.aRowId, candidate.bRowId) == ("A-IV-701", "B-IV-301")
    assert candidate.band == "needs_review"
    assert candidate.matchScore == 1
    assert candidate.evidence[0].evidenceClass == "exact_agreement"
    assert result.matcherConfig["decisions"]["minimumAutoAgreementFields"] == 2


def test_candidate_config_version_must_match_frozen_matcher_provenance(
    tmp_path: Path,
) -> None:
    a_path, b_path = tmp_path / "a.csv", tmp_path / "b.csv"
    _write(a_path, "id,stable-id\nA1,VEND-7001\n")
    _write(b_path, "id,stable-id\nB1,VEND-7001\n")

    with pytest.raises(ValueError, match="must match frozen matcher provenance"):
        match_csvs_explainable(
            a_path,
            b_path,
            [mapping("stable-id")],
            candidate_config=CandidateEngineConfig(
                engineVersion="candidate-engine-v0.2.0"
            ),
        )
