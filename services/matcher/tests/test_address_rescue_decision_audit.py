"""Actual matcher decision gates for the SW-053 evaluation-only probe."""

import pytest

from samewise_matcher.address_rescue_decision_audit import (
    AUDIT_VERSION,
    run_decision_audit,
)


@pytest.mark.parametrize("seed", [5201, 5301])
def test_audit_is_truth_isolated_and_preserves_baseline(seed: int) -> None:
    result = run_decision_audit(100, seed=seed)
    baseline = result["baseline"]
    combined = result["withAddressProbe"]
    delta = result["delta"]
    assert result["auditVersion"] == AUDIT_VERSION
    assert result["baselineMatcherVersion"] == "explainable-matcher-v0.3.0"
    assert result["baselineCandidateEngineVersion"] == "candidate-engine-v0.4.0"
    assert result["evaluationOnlyEvidenceMarker"].startswith("sw-053")
    assert combined["generatedCandidatePairs"] >= baseline["generatedCandidatePairs"]
    assert combined["generatedTruePairs"] >= baseline["generatedTruePairs"]
    assert baseline["displayedTruePairs"] <= baseline["generatedTruePairs"]
    assert combined["displayedTruePairs"] <= combined["generatedTruePairs"]
    assert baseline["correctAutoMatchedPairs"] + baseline[
        "incorrectAutoMatchedPairs"
    ] == baseline["autoMatchedPairs"]
    assert combined["correctAutoMatchedPairs"] + combined[
        "incorrectAutoMatchedPairs"
    ] == combined["autoMatchedPairs"]
    assert delta["truePairsNewlyGenerated"] >= 0
    assert delta["additionalCandidatePairs"] > 0
    assert delta["formerlyAutoMatchedPairsDisplaced"] >= 0


def test_strict_cap_is_measured_after_scoring_and_review_policy() -> None:
    default = run_decision_audit(100, max_bucket_pair_count=100)
    strict = run_decision_audit(100, max_bucket_pair_count=4)
    assert strict["fixtureSha256"] == default["fixtureSha256"]
    assert strict["baseline"] == default["baseline"]
    assert strict["delta"]["additionalCandidatePairs"] < (
        default["delta"]["additionalCandidatePairs"]
    )
    assert strict["delta"]["truePairsNewlyGenerated"] < (
        default["delta"]["truePairsNewlyGenerated"]
    )
    assert strict["withAddressProbe"]["generatedTruePairs"] <= (
        default["withAddressProbe"]["generatedTruePairs"]
    )


def test_empty_review_or_auto_matches_have_explicit_denominators() -> None:
    result = run_decision_audit(20)
    for condition in ("baseline", "withAddressProbe"):
        metrics = result[condition]
        if metrics["autoMatchedPairs"] == 0:
            assert metrics["autoMatchPrecision"] is None
        else:
            assert 0 <= metrics["autoMatchPrecision"] <= 1
        assert metrics["reviewEntityRows"] >= 0
        assert metrics["collisionTopCandidates"] >= 0
        assert metrics["onlyARows"] >= 0
        assert metrics["onlyBRows"] >= 0
        assert metrics["topRankedFalsePairs"] >= 0
        assert metrics["displayedFalsePairs"] >= 0
