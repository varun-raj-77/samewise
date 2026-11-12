"""Deterministic adversarial gates before any address-only product activation."""

import pytest

from samewise_matcher.address_adversarial import (
    ADVERSARIAL_VERSION,
    adversarial_scenarios,
    evaluate_adversarial_scenario,
    run_adversarial_scenarios,
)


def by_key() -> dict[str, dict[str, object]]:
    return {item["scenario"]: item for item in run_adversarial_scenarios()}


def test_independent_cases_cover_distinct_identity_risks() -> None:
    cases = adversarial_scenarios()
    keys = [case.key for case in cases]
    assert len(keys) == len(set(keys)) == 12
    assert all(case.a and case.b for case in cases)
    for case in cases:
        assert len({row.row_id for row in case.a}) == len(case.a)
        assert len({row.row_id for row in case.b}) == len(case.b)


def test_probe_only_similarity_can_create_wrong_automatic_identity() -> None:
    """An unrelated address-sharing tenant must invalidate the zero-FP claim."""

    scenario = next(
        item for item in adversarial_scenarios()
        if item.key == "unrelated_tenant_false_auto"
    )
    result = evaluate_adversarial_scenario(scenario)
    assert result["adversarialVersion"] == ADVERSARIAL_VERSION
    assert result["truePairs"] == 0
    assert result["baselineCandidates"] == 0
    assert result["probeOnlyCandidates"] == 1
    assert result["probeOnlyFalsePairs"] == 1
    assert result["baselineWrongAutoMatches"] == 0
    # This is a diagnostic of the CURRENT unchanged scoring policy, not a
    # product assertion that false auto-matching is acceptable.
    assert result["newWrongAutoMatches"] == 1
    wrong = result["newWrongAutoPairScores"]
    assert wrong[0]["aRowId"] == "A1"
    assert wrong[0]["bRowId"] == "B1"
    assert wrong[0]["score"] >= 0.5


def test_region_conflict_does_not_prevent_city_only_probe_key() -> None:
    scenario = next(
        item for item in adversarial_scenarios()
        if item.key == "same_city_different_state"
    )
    result = evaluate_adversarial_scenario(scenario)
    assert result["confirmedRegionMapping"] is True
    assert result["truePairs"] == 0
    # The current probe considers city and state as separate geography
    # alternatives. An agreeing city can admit a pair despite state conflict.
    assert result["probeOnlyCandidates"] == 1
    assert result["probeOnlyFalsePairs"] == 1


def test_rebrand_can_be_recovered_without_trusting_name_overlap() -> None:
    case = next(
        item for item in adversarial_scenarios()
        if item.key == "renamed_same_site"
    )
    result = evaluate_adversarial_scenario(case)
    assert result["truePairs"] == 1
    assert result["baselineCandidates"] == 0
    assert result["probeOnlyTruePairs"] == 1
    assert result["combinedVisibleTruth"] >= result["baselineVisibleTruth"]


def test_shared_building_has_multiple_real_alternatives_and_false_pairs() -> None:
    case = next(
        item for item in adversarial_scenarios()
        if item.key == "shared_building_two_rebrands"
    )
    result = evaluate_adversarial_scenario(case)
    assert result["truePairs"] == 2
    assert result["probeOnlyTruePairs"] >= 1
    assert result["probeOnlyFalsePairs"] >= 1


def test_moved_business_and_nonmatching_locations_do_not_emit_address_key() -> None:
    results = by_key()
    for key in (
        "relocated_same_entity", "different_cities",
        "different_street_same_number", "address_without_locality",
        "name_collision_only",
    ):
        assert results[key]["probeOnlyCandidates"] == 0


def test_same_name_can_already_create_false_auto_match_without_probe() -> None:
    result = by_key()["same_name_unrelated"]
    assert result["truePairs"] == 0
    assert result["baselineCandidates"] == 1
    assert result["baselineWrongAutoMatches"] == 1
    assert result["probeOnlyCandidates"] == 0


def test_all_results_replay_and_keep_truth_out_of_visible_source() -> None:
    first = run_adversarial_scenarios()
    second = run_adversarial_scenarios()
    assert first == second
    assert all(item["scope"].startswith("hand-constructed") for item in first)
    assert any(item["newWrongAutoMatches"] > 0 for item in first)
    assert any(item["probeOnlyTruePairs"] > 0 for item in first)


@pytest.mark.parametrize(
    ("scenario", "minimum_score"),
    [
        ("unrelated_tenant_false_auto", 0.62),
        ("previous_tenant_successor", 0.57),
        ("same_city_different_state", 0.54),
        ("shared_address_b_with_no_counterpart", 0.62),
    ],
)
def test_new_address_only_pairs_can_be_wrong_auto_matches(
    scenario: str, minimum_score: float,
) -> None:
    report = by_key()[scenario]
    assert report["truePairs"] == 0
    assert report["baselineWrongAutoMatches"] == 0
    assert report["probeOnlyFalsePairs"] == 1
    assert report["newWrongAutoMatches"] == 1
    assert report["newWrongAutoPairScores"][0]["score"] >= minimum_score
