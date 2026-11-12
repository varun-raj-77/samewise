"""Synthetic, truth-separated tests for the SW-052 candidate-only experiment."""

import pytest

from samewise_matcher.address_location_probe import (
    evaluate_address_location_probe,
    generate_address_location_candidates,
)
from samewise_matcher.candidate_engine import generate_candidates
from samewise_matcher.workflow_models import ManualMapping


def mappings() -> list[ManualMapping]:
    return [
        ManualMapping(
            mappingId="organization", label="Organization", aColumn="org",
            bColumn="business", role="identity", normalizer="text",
            semanticFamily="name_or_title",
        ),
        ManualMapping(
            mappingId="street", label="Street", aColumn="street",
            bColumn="address", role="identity", normalizer="text",
            semanticFamily="address",
        ),
        ManualMapping(
            mappingId="locality", label="Locality", aColumn="city",
            bColumn="town", role="identity", normalizer="text",
            semanticFamily="geography",
        ),
    ]


A_HEADERS = ["id", "org", "street", "city"]
B_HEADERS = ["id", "business", "address", "town"]
A_ROWS = [
    {
        "id": "A1",
        "org": "Northstar Holdings",
        "street": "42 High Street",
        "city": "Boston",
    },
    {"id": "A2", "org": "Cedar Freight", "street": "42 High Street", "city": "Boston"},
    {
        "id": "A3",
        "org": "Orion Medical",
        "street": "700 River Street",
        "city": "Boston",
    },
]
B_ROWS = [
    {
        "id": "B1",
        "business": "Bluebird Data",
        "address": "42 High St",
        "town": "BOSTON",
    },
    {"id": "B2", "business": "Maple Clinic", "address": "42 High St", "town": "Boston"},
    {
        "id": "B3",
        "business": "Orion Medical",
        "address": "700 River St",
        "town": "Boston",
    },
]
TRUTH = {("A1", "B1"), ("A2", "B2"), ("A3", "B3")}
HARD_NEGATIVES = {("A1", "B2"), ("A2", "B1")}


def probe(**kwargs):
    return generate_address_location_candidates(
        A_HEADERS, A_ROWS, B_HEADERS, B_ROWS, mappings(), **kwargs
    )


def test_name_change_rescue_measures_shared_building_hard_negatives() -> None:
    # The production baseline gets the unchanged name, but not renamed entities.
    baseline = generate_candidates(
        A_HEADERS, A_ROWS, B_HEADERS, B_ROWS, mappings()
    )
    baseline_pairs = {(item.aRowId, item.bRowId) for item in baseline.candidates}
    assert baseline_pairs == {("A3", "B3")}

    result = probe()
    assert result.candidate_pairs == frozenset(
        {
            ("A1", "B1"),
            ("A1", "B2"),
            ("A2", "B1"),
            ("A2", "B2"),
            ("A3", "B3"),
        }
    )
    metrics = evaluate_address_location_probe(baseline, result, TRUTH, HARD_NEGATIVES)
    assert metrics["baselineCandidateEngineVersion"] == "candidate-engine-v0.4.0"
    assert metrics["baselineCandidates"] == 1
    assert metrics["addedCandidates"] == 4
    assert metrics["newlyRecoveredTruePairs"] == 2
    assert metrics["newlyAdmittedKnownHardNegatives"] == 2
    assert metrics["additionalPairsWithoutKnownTruthLabel"] == 0
    assert metrics["baselineCandidateRecall"] == round(1 / 3, 9)
    assert metrics["combinedCandidateRecall"] == 1
    assert metrics["addressKeysUsed"] == 2
    assert metrics["addressKeysSuppressed"] == 0


def test_bucket_cap_suppresses_shared_address_without_partial_selection() -> None:
    result = probe(max_bucket_size_per_side=1)
    assert result.keys_suppressed == 1
    assert result.relationships_suppressed == 4
    assert result.keys_used == 1
    assert result.candidate_pairs == frozenset({("A3", "B3")})


def test_pair_cap_suppresses_expensive_address_bucket() -> None:
    result = probe(max_bucket_pair_count=3)
    assert result.keys_suppressed == 1
    assert result.candidate_pairs == frozenset({("A3", "B3")})


def test_geography_must_match_even_for_exact_street() -> None:
    result = generate_address_location_candidates(
        A_HEADERS, [A_ROWS[0]], B_HEADERS,
        [{**B_ROWS[0], "town": "Cambridge"}], mappings(),
    )
    assert result.candidate_pairs == frozenset()


def test_missing_address_never_generates_key() -> None:
    result = generate_address_location_candidates(
        A_HEADERS, [{**A_ROWS[0], "street": ""}],
        B_HEADERS, [B_ROWS[0]], mappings(),
    )
    assert result.candidate_pairs == frozenset()


def test_row_order_does_not_change_proposed_pairs_or_counts() -> None:
    first = probe()
    second = generate_address_location_candidates(
        A_HEADERS, list(reversed(A_ROWS)),
        B_HEADERS, list(reversed(B_ROWS)), mappings(),
    )
    assert first == second


def test_probe_requires_confirmed_identity_address_and_locality() -> None:
    with pytest.raises(ValueError, match="address and geography"):
        generate_address_location_candidates(
            A_HEADERS, A_ROWS, B_HEADERS, B_ROWS, mappings()[:2],
        )
    comparison_mapping = mappings()[2].model_copy(update={"role": "comparison"})
    with pytest.raises(ValueError, match="address and geography"):
        generate_address_location_candidates(
            A_HEADERS, A_ROWS, B_HEADERS, B_ROWS,
            mappings()[:2] + [comparison_mapping],
        )


def test_probe_rejects_invalid_caps_and_missing_source_columns() -> None:
    with pytest.raises(ValueError, match="bucket caps"):
        probe(max_bucket_pair_count=0)
    with pytest.raises(ValueError, match="absent source column"):
        generate_address_location_candidates(
            A_HEADERS, A_ROWS, ["id", "business", "town"], B_ROWS, mappings(),
        )


def test_truth_and_hard_negative_labels_must_be_disjoint() -> None:
    baseline = generate_candidates(
        A_HEADERS, A_ROWS, B_HEADERS, B_ROWS, mappings()
    )
    with pytest.raises(ValueError, match="must be disjoint"):
        evaluate_address_location_probe(
            baseline, probe(), TRUTH, {("A1", "B1")},
        )


def test_probe_rejects_duplicate_row_ids_in_either_source() -> None:
    with pytest.raises(ValueError, match="unique source row IDs"):
        generate_address_location_candidates(
            A_HEADERS, [A_ROWS[0], A_ROWS[0]],
            B_HEADERS, B_ROWS, mappings(),
        )
