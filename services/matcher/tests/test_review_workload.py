from pathlib import Path

from samewise_matcher.review_workload import (
    REVIEW_WORKLOAD_ANALYSIS_VERSION,
    ReviewWorkloadConfig,
    analyze_review_workload,
    generate_public_review_workload,
)


def config() -> ReviewWorkloadConfig:
    return ReviewWorkloadConfig(
        fixtureName="review-workload-test-v1",
        seed=7,
        rowsA=32,
        rowsB=32,
        overlap=24,
        aOnly=8,
        bOnly=8,
        clearOverlap=18,
        ambiguousOverlap=6,
        pairedSourceOnlyNoise=7,
        contactGroupSize=7,
    )


def test_fixture_is_deterministic_and_truth_is_separate() -> None:
    first = generate_public_review_workload(config())
    second = generate_public_review_workload(config())
    assert first == second
    a_rows, b_rows, truth_a, truth_b = first
    assert len(a_rows) == len(b_rows) == 32
    assert all("canonical" not in key for row in [*a_rows, *b_rows] for key in row)
    assert len(set(truth_a.values()) & set(truth_b.values())) == 24


def test_analysis_records_review_forensics() -> None:
    report = analyze_review_workload(config())
    assert report["analysisVersion"] == REVIEW_WORKLOAD_ANALYSIS_VERSION
    assert report["metrics"]["theoreticalPairs"] == 1024
    assert report["metrics"]["candidateRecall"] == 1.0
    assert report["metrics"]["falseAutoMatchCount"] == 0
    assert report["reviewCases"]
    case = report["reviewCases"][0]
    assert {
        "aRecordId",
        "topCandidateBRecordId",
        "topCandidateIsTruePair",
        "trueCandidateRank",
        "topScore",
        "secondScore",
        "topSecondMargin",
        "candidateCount",
        "collision",
        "blockingProvenance",
        "fieldEvidence",
        "strongContradiction",
    } <= case.keys()


def test_public_semantic_workload_has_mutually_exclusive_primary_states() -> None:
    root = Path(__file__).parents[3]
    public_config = ReviewWorkloadConfig.model_validate_json(
        (
            root
            / "evaluation"
            / "benchmark-configs"
            / "public-review-workload-8k-v1.json"
        ).read_text(encoding="utf-8")
    )
    report = analyze_review_workload(public_config, semantic=True)
    metrics = report["metrics"]
    assert metrics["autoMatchCount"] == public_config.clearOverlap
    assert metrics["reviewCount"] == public_config.ambiguousOverlap
    assert metrics["primaryNoMatchFoundInB"] == public_config.aOnly
    assert metrics["primaryNoMatchFoundInA"] == public_config.bOnly
    assert metrics["onlyB"] == (
        public_config.bOnly + public_config.ambiguousOverlap
    )
