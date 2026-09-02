from samewise_matcher.candidate_engine import (
    CandidateEngineConfig,
    generate_candidates,
)
from samewise_matcher.candidate_falsification import (
    analyze_hard_negatives,
    analyze_suppression,
    run_falsification,
    stratify_exact_identifiers,
)
from samewise_matcher.workflow_models import ManualMapping


def mapping(
    mapping_id: str,
    a_column: str,
    b_column: str,
    normalizer: str = "text",
) -> ManualMapping:
    return ManualMapping(
        mappingId=mapping_id,
        label=mapping_id,
        aColumn=a_column,
        bColumn=b_column,
        role="identity",
        normalizer=normalizer,
    )


def test_exact_identifier_stratification_is_evaluation_only() -> None:
    mappings = [
        mapping("phone", "phone", "telephone", "phone"),
        mapping("organization-name", "name", "organization"),
    ]
    a = [
        {"id": "A1", "phone": "5550101000", "name": "Acme"},
        {"id": "A2", "phone": "", "name": "Harbor Medical"},
    ]
    b = [
        {"id": "B1", "telephone": "+1 555 010 1000", "organization": "Acme"},
        {"id": "B2", "telephone": "", "organization": "Harbor Medcial"},
    ]
    truth = {("A1", "B1"), ("A2", "B2")}
    strong, weak = stratify_exact_identifiers(
        truth,
        ["id", "phone", "name"],
        a,
        ["id", "telephone", "organization"],
        b,
        mappings,
        CandidateEngineConfig(),
    )
    assert strong == {("A1", "B1")}
    assert weak == {("A2", "B2")}


def test_suppressed_name_key_is_measured_and_rescued_by_address_blocker() -> None:
    config = CandidateEngineConfig(
        enabledBlockers=("name_token_v1", "address_name_v1"),
        stopTokens=(),
        maxBucketSizePerSide=2,
        maxBucketPairCount=100,
    )
    mappings = [
        mapping("organization-name", "name", "organization"),
        mapping("address", "street", "address"),
    ]
    a = [
        {"id": f"A{i}", "name": "Common Alpha", "street": f"{i} Main St"}
        for i in range(1, 4)
    ]
    b = [
        {"id": f"B{i}", "organization": "Common Beta", "address": f"{i} Main St"}
        for i in range(1, 4)
    ]
    result = generate_candidates(
        ["id", "name", "street"],
        a,
        ["id", "organization", "address"],
        b,
        mappings,
        config,
    )
    analysis = analyze_suppression(
        result,
        {("A1", "B1")},
        ["id", "name", "street"],
        a,
        ["id", "organization", "address"],
        b,
        mappings,
    )
    assert analysis["truePairsWithSuppressedUsefulKey"] == 1
    assert analysis["truePairsRetainedDespiteSuppression"] == 1
    assert analysis["truePairsRescuedByDifferentBlocker"] == 1
    assert analysis["truePairsMissedAfterSuppression"] == 0


def test_hard_negative_can_legitimately_enter_candidate_set() -> None:
    item = mapping("organization-name", "name", "organization")
    a = [
        {"id": "A1", "name": "Northstar Medical Group"},
        {"id": "A2", "name": "Northstar Medical Supply"},
    ]
    b = [
        {"id": "B1", "organization": "Northstar Medical Group"},
        {"id": "B2", "organization": "Northstar Medical Supply"},
    ]
    result = generate_candidates(["id", "name"], a, ["id", "organization"], b, [item])
    truth = {
        "source_a": [
            {"source_row_id": "A1", "canonical_entity_id": "e1"},
            {"source_row_id": "A2", "canonical_entity_id": "e2"},
        ],
        "source_b": [
            {"source_row_id": "B1", "canonical_entity_id": "e1"},
            {"source_row_id": "B2", "canonical_entity_id": "e2"},
        ],
    }
    hard = {
        "patterns": [
            {
                "left_canonical_entity_id": "e1",
                "right_canonical_entity_id": "e2",
                "pattern": "similar-name",
            }
        ]
    }
    coverage = analyze_hard_negatives(result, truth, hard)
    assert coverage["knownCrossSourcePairs"] == 2
    assert coverage["candidatePairsEntered"] == 2
    assert coverage["blockerCounts"]["name_token_v1"] == 2


def test_ablation_without_exact_identifiers_retains_weak_name_location_pair() -> None:
    mappings = [
        mapping("phone", "phone", "telephone", "phone"),
        mapping("organization-name", "name", "organization"),
        mapping("city", "city", "locality"),
    ]
    a = [{"id": "A1", "phone": "", "name": "Harbor Medical", "city": "Boston"}]
    b = [
        {
            "id": "B1",
            "telephone": "",
            "organization": "Harbor Medcial",
            "locality": "BOSTON",
        }
    ]
    truth = {
        "source_a": [{"source_row_id": "A1", "canonical_entity_id": "e1"}],
        "source_b": [{"source_row_id": "B1", "canonical_entity_id": "e1"}],
    }
    report = run_falsification(
        ["id", "phone", "name", "city"],
        a,
        ["id", "telephone", "organization", "locality"],
        b,
        mappings,
        CandidateEngineConfig(),
        truth,
        {"patterns": []},
        {"fixture_name": "hand-constructed"},
    )
    ablations = {item["variant"]: item for item in report["ablations"]}
    assert ablations["exact_only"]["candidateRecall"] == 0
    assert ablations["without_exact_strong_v1"]["candidateRecall"] == 1
    assert report["stratifiedRecall"]["weakIdentifier"]["candidateRecall"] == 1
