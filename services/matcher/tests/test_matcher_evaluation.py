import json
from pathlib import Path

import pytest

from samewise_matcher.candidate_engine import (
    CandidateEngineConfig,
    CandidateGenerationResult,
    GeneratedCandidate,
)
from samewise_matcher.explainable_matcher import (
    DecisionRules,
    MatcherConfig,
    score_candidate,
)
from samewise_matcher.matcher_evaluation import (
    _post_score_retention_losses,
    _quality_metrics,
    _score_bands,
    evaluate_matcher,
    select_thresholds,
)
from samewise_matcher.workflow_models import BlockingEvidenceView, ManualMapping

NAME = ManualMapping(
    mappingId="organization-name",
    label="Organization name",
    aColumn="name",
    bColumn="name",
    role="identity",
    normalizer="text",
)
BLOCKING = [BlockingEvidenceView(blockerId="name_token_v1", keyHash="0123456789abcdef")]


def pair(a_id: str, b_id: str, score: float, *, contradiction: bool = False):
    value = score_candidate(
        a_id,
        b_id,
        {"name": "Acme"},
        {"name": "Acme"},
        [NAME],
        BLOCKING,
        MatcherConfig(),
    )
    return value.model_copy(
        update={
            "matchScore": score,
            "strongContradiction": contradiction,
            "agreementFields": 2,
        }
    )


def rules() -> DecisionRules:
    return DecisionRules(
        autoMatchThreshold=0.7,
        reviewThreshold=0.3,
        minimumTopCandidateMargin=0.1,
        minimumAutoAgreementFields=1,
    )


def test_metric_arithmetic_denominators_duplicates_source_only_and_decomposition() -> (
    None
):
    scored = [
        pair("A1", "B1", 0.9),
        pair("A2", "BX", 0.6),
        pair("A2", "B2", 0.4),
        pair("A3", "BY", 0.8),
    ]
    truth = {("A1", "B1"), ("A2", "B2"), ("A2", "B3")}
    metrics, _ = _quality_metrics(scored, truth, {"A1", "A2", "A3"}, rules())

    assert metrics["candidateTruePairs"] == 2
    assert metrics["candidateMisses"] == 1
    assert metrics["candidateRecall"] == pytest.approx(2 / 3)
    assert metrics["autoMatchCount"] == 2
    assert metrics["trueAutoMatches"] == 1
    assert metrics["falseAutoMatches"] == 1
    assert metrics["autoMatchPrecision"] == 0.5
    assert metrics["autoMatchRecall"] == pytest.approx(1 / 3)
    assert metrics["reviewRateDenominatorCount"] == 2
    assert metrics["reviewRoutedARows"] == 1
    assert metrics["reviewRate"] == 0.5
    assert metrics["candidateConditionalFeatureScoringCoverage"] == 1
    assert metrics["candidateConditionalReviewThresholdCoverage"] == 1
    assert metrics["matchableARows"] == 2
    assert metrics["autoMatchedARows"] == 1
    assert metrics["unmatchedMatchableARows"] == 0
    assert metrics["truthUncoveredARows"] == 0
    assert metrics["truthUncoveredReviewRows"] == 0
    assert metrics["top1TrueCandidateRows"] == 1
    assert metrics["top1EligibleRows"] == 2
    assert metrics["top1TrueCandidateRate"] == 0.5
    assert metrics["sourceOnlyARows"] == 1
    assert metrics["endToEndRecovery"] <= metrics["candidateRecall"]
    assert (
        metrics["candidateMisses"] + metrics["candidateTruePairs"]
        == metrics["truePairsTotal"]
    )


def test_below_threshold_pair_is_separate_from_candidate_miss_and_row_coverage() -> (
    None
):
    scored = [pair("A1", "B1", 0.2)]
    truth = {("A1", "B1"), ("A2", "B2")}
    metrics, _ = _quality_metrics(scored, truth, {"A1", "A2"}, rules())
    assert metrics["candidateMisses"] == 1
    assert metrics["scoredTruePairs"] == 1
    assert metrics["belowReviewThresholdTruePairs"] == 1
    assert metrics["candidateConditionalReviewThresholdCoverage"] == 0
    assert metrics["truthUncoveredARows"] == 2
    assert metrics["truthUncoveredUnmatchedRows"] == 2
    assert metrics["retainedTruePairs"] == 0
    assert metrics["endToEndRecovery"] == 0


def test_post_score_retention_loss_identifies_top_n_tradeoff() -> None:
    scored = [
        pair("A1", "BX", 0.9),
        pair("A1", "BY", 0.8),
        pair("A1", "BZ", 0.7),
        pair("A1", "B1", 0.65),
    ]
    decisions = rules().model_copy(
        update={"alternativeWindow": 0.5, "maxAlternatives": 3}
    )
    metrics, classified = _quality_metrics(scored, {("A1", "B1")}, {"A1"}, decisions)
    losses = _post_score_retention_losses(scored, {("A1", "B1")}, classified, decisions)
    assert metrics["postScoreRetentionMisses"] == 1
    assert losses == [
        {
            "aRowId": "A1",
            "bRowId": "B1",
            "generated": True,
            "matchScore": 0.65,
            "rank": 4,
            "reason": "top_n_alternative_limit",
            "decisionBand": "auto_match",
            "topScore": 0.9,
            "topCandidateMargin": 0.1,
            "collision": False,
            "reviewThreshold": 0.3,
            "retentionCutoff": 0.4,
            "maxAlternatives": 3,
        }
    ]


def test_sw005f_candidate_ceiling_remains_1093_of_1101_with_eight_misses() -> None:
    root = Path(__file__).resolve().parents[3]
    report = json.loads(
        (
            root / "evaluation/reports/sw-005f/falsification-report-v0.2.0.json"
        ).read_text()
    )
    current = next(
        item
        for item in report["engineComparison"]
        if item["engine"] == "candidate-engine-v0.2.0"
    )
    assert current["truePairsRetained"] == 1093
    assert current["truePairsMissed"] == 8
    assert current["truePairsRetained"] + current["truePairsMissed"] == 1101
    assert current["candidateRecall"] == pytest.approx(1093 / 1101)


def test_sw006_holdout_pair_and_row_reconciliation_is_explicit() -> None:
    root = Path(__file__).resolve().parents[3]
    report = json.loads(
        (root / "evaluation/reports/sw-006/holdout/report.json").read_text()
    )
    assert report["evaluationVersion"] == "matcher-evaluation-v0.2.0"
    assert report["decomposition"]["pairLevel"] == {
        "totalTrueCrossSourceLinks": 879,
        "candidateRetainedTrueLinks": 866,
        "candidateMissedTrueLinks": 13,
        "featureScoredTrueLinks": 866,
        "trueLinksAtOrAboveReviewThreshold": 866,
        "trueLinksBelowReviewThreshold": 0,
        "postScoreRetentionMisses": 2,
        "endToEndRecoverableTrueLinks": 864,
    }
    assert report["decomposition"]["aRowLevel"] == {
        "matchableARows": 858,
        "autoMatchedARows": 253,
        "reviewRoutedARows": 598,
        "unmatchedMatchableARows": 7,
        "recoverableMatchableARows": 844,
        "truthUncoveredARows": 14,
        "truthUncoveredAutoRows": 0,
        "truthUncoveredReviewRows": 7,
        "truthUncoveredUnmatchedRows": 7,
    }
    assert [
        (item["aRowId"], item["bRowId"], item["rank"], item["reason"])
        for item in report["postScoreRetentionLosses"]
    ] == [
        ("A000491", "B000713", 4, "top_n_alternative_limit"),
        ("A000685", "B000767", 4, "top_n_alternative_limit"),
    ]


def test_score_band_statistics_do_not_treat_review_as_confirmed_positive() -> None:
    bands = _score_bands(
        [pair("A1", "B1", 0.95), pair("A1", "B2", 0.92), pair("A2", "B3", 0.15)],
        {("A1", "B1")},
    )
    high = next(item for item in bands if item["band"] == "0.9-1.0")
    assert high == {
        "band": "0.9-1.0",
        "candidateCount": 2,
        "trueMatchCount": 1,
        "falseMatchCount": 1,
        "empiricalMatchRate": 0.5,
    }


def test_threshold_selection_is_deterministic_conservative_and_freezes_tuning() -> None:
    scored = [
        pair("A1", "B1", 0.9),
        pair("A2", "B2", 0.8),
        pair("A3", "BX", 0.75),
        pair("A3", "B3", 0.7),
    ]
    truth = {("A1", "B1"), ("A2", "B2"), ("A3", "B3")}
    template = MatcherConfig(frozen=False, tunedOnFixture=None)
    first, first_report = select_thresholds(scored, truth, {"A1", "A2", "A3"}, template)
    second, second_report = select_thresholds(
        scored, truth, {"A1", "A2", "A3"}, template
    )
    assert first == second
    assert first_report == second_report
    assert first.frozen
    assert first_report["selectedMetrics"]["falseAutoMatches"] == 0


def generation() -> CandidateGenerationResult:
    config = CandidateEngineConfig()
    return CandidateGenerationResult(
        engineVersion=config.engineVersion,
        normalizationVersion=config.normalizationVersion,
        config=config,
        aRowCount=1,
        bRowCount=1,
        candidates=[
            GeneratedCandidate(
                candidateId="candidate-0123456789abcdef0123",
                aRowId="A1",
                bRowId="B1",
                blockingEvidence=[
                    {"blockerId": "name_token_v1", "keyHash": "0123456789abcdef"}
                ],
            )
        ],
        zeroCandidateARowIds=[],
        zeroCandidateBRowIds=[],
        blockerDiagnostics=[],
    )


def test_holdout_requires_config_frozen_on_a_different_tuning_fixture() -> None:
    scored = [pair("A1", "B1", 0.9)]
    truth_payload = {
        "source_a": [{"canonical_entity_id": "E1", "source_row_id": "A1"}],
        "source_b": [{"canonical_entity_id": "E1", "source_row_id": "B1"}],
    }
    hard_negatives = {"patterns": []}
    fixture = {"fixture_name": "holdout", "seed": 2}
    with pytest.raises(ValueError, match="frozen tuning config"):
        evaluate_matcher(
            generation(),
            scored,
            scored,
            {("A1", "B1")},
            truth_payload,
            hard_negatives,
            {"A1"},
            MatcherConfig(frozen=False, tunedOnFixture=None),
            fixture,
            phase="holdout",
        )
    with pytest.raises(ValueError, match="cannot be the tuning fixture"):
        evaluate_matcher(
            generation(),
            scored,
            scored,
            {("A1", "B1")},
            truth_payload,
            hard_negatives,
            {"A1"},
            MatcherConfig(frozen=True, tunedOnFixture="holdout"),
            fixture,
            phase="holdout",
        )
    report = evaluate_matcher(
        generation(),
        scored,
        scored,
        {("A1", "B1")},
        truth_payload,
        hard_negatives,
        {"A1"},
        MatcherConfig(frozen=True, tunedOnFixture="tune"),
        fixture,
        phase="holdout",
    )
    assert report["phase"] == "holdout"
    assert report["metrics"]["candidateRecall"] == 1


def test_hard_negative_auto_match_count_uses_explicit_evaluation_pairs() -> None:
    scored = [pair("A1", "B2", 0.9)]
    truth_payload = {
        "source_a": [{"canonical_entity_id": "E1", "source_row_id": "A1"}],
        "source_b": [{"canonical_entity_id": "E2", "source_row_id": "B2"}],
    }
    hard_negatives = {
        "patterns": [
            {
                "left_canonical_entity_id": "E1",
                "right_canonical_entity_id": "E2",
                "pattern": "similar_name",
            }
        ]
    }
    report = evaluate_matcher(
        generation(),
        scored,
        scored,
        set(),
        truth_payload,
        hard_negatives,
        {"A1"},
        MatcherConfig(frozen=True, tunedOnFixture="tune").model_copy(
            update={"decisions": rules()}
        ),
        {"fixture_name": "holdout", "seed": 2},
        phase="holdout",
    )
    assert report["metrics"]["hardNegativeCandidatePairs"] == 1
    assert report["metrics"]["hardNegativeAutoMatches"] == 1
