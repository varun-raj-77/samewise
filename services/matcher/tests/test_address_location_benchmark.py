"""Adversarial, reproducible validation of the SW-052 synthetic benchmark."""

import pytest

from samewise_matcher.address_location_benchmark import (
    generate_address_rescue_fixture,
    run_address_rescue_benchmark,
)


def test_fixture_is_reproducible_and_keeps_truth_outside_visible_rows() -> None:
    first = generate_address_rescue_fixture(1000, seed=5201)
    second = generate_address_rescue_fixture(1000, seed=5201)
    different_seed = generate_address_rescue_fixture(1000, seed=5202)
    assert first.fingerprint == second.fingerprint
    assert first.fingerprint != different_seed.fingerprint
    assert first.a_rows == second.a_rows
    assert first.b_rows == second.b_rows
    assert len(first.a_rows) == len(first.b_rows) == len(first.truth_pairs) == 1000
    assert len(first.known_hard_negatives) == 600
    assert not first.truth_pairs & first.known_hard_negatives
    assert first.category_counts["shared_address_groups"] == 50
    assert first.category_counts["shared_address_entities"] == 200
    for row in first.a_rows + first.b_rows:
        assert "canonical_entity_id" not in row
        assert "truth" not in row


@pytest.mark.parametrize("bad_size", [0, 19, 999, 1001])
def test_fixture_rejects_nonversioned_size_shapes(bad_size: int) -> None:
    with pytest.raises(ValueError, match="multiple of 20"):
        generate_address_rescue_fixture(bad_size)


def test_1k_benchmark_proves_rescue_and_hard_negative_tradeoff() -> None:
    report = run_address_rescue_benchmark(1000, seed=5201)
    metrics = report["candidateMetrics"]
    assert report["benchmarkVersion"] == "sw-052-address-rescue-benchmark-v0.1.0"
    assert report["fixtureVersion"] == "address-rescue-synthetic-v0.1.0"
    assert metrics["knownTruePairs"] == 1000
    assert metrics["baselineCandidateEngineVersion"] == "candidate-engine-v0.4.0"
    assert 0 < metrics["baselineCandidateRecall"] < metrics["combinedCandidateRecall"]
    assert metrics["combinedCandidateRecall"] <= 1
    assert metrics["newlyRecoveredTruePairs"] > 0
    assert metrics["newlyAdmittedKnownHardNegatives"] > 0
    assert metrics["addedCandidates"] == (
        metrics["newlyRecoveredTruePairs"]
        + metrics["completeTruthNewlyAdmittedFalseCandidates"]
    )
    assert (
        metrics["completeTruthNewlyAdmittedFalseCandidates"]
        >= metrics["newlyAdmittedKnownHardNegatives"]
    )
    assert metrics["combinedCandidates"] >= metrics["baselineCandidates"]
    assert metrics["addressKeysSuppressed"] >= 0
    assert report["performance"]["baselineSeconds"] >= 0
    assert report["performance"]["probeSeconds"] >= 0
    assert report["performance"]["baselinePeakTracedPythonBytes"] > 0


def test_strict_bucket_cap_has_measured_recall_and_negative_tradeoff() -> None:
    unrestricted = run_address_rescue_benchmark(20)
    restrictive = run_address_rescue_benchmark(20, max_bucket_pair_count=4)
    full = unrestricted["candidateMetrics"]
    capped = restrictive["candidateMetrics"]
    assert capped["addressKeysSuppressed"] > full["addressKeysSuppressed"]
    assert capped["addressRelationshipsSuppressed"] >= 8
    assert capped["addedCandidates"] <= full["addedCandidates"]
    assert capped["newlyAdmittedKnownHardNegatives"] <= (
        full["newlyAdmittedKnownHardNegatives"]
    )
    assert capped["combinedCandidateRecall"] <= full["combinedCandidateRecall"]
