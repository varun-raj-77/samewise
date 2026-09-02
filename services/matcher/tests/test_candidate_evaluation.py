from samewise_matcher.candidate_engine import CandidateEngineConfig, generate_candidates
from samewise_matcher.candidate_evaluation import evaluate_candidates
from samewise_matcher.workflow_models import ManualMapping


def mapping() -> ManualMapping:
    return ManualMapping(
        mappingId="phone",
        label="Phone",
        aColumn="phone",
        bColumn="telephone",
        role="identity",
        normalizer="phone",
    )


def generated(a_rows, b_rows):
    return generate_candidates(
        ["id", "phone"],
        a_rows,
        ["id", "telephone"],
        b_rows,
        [mapping()],
        CandidateEngineConfig(enabledBlockers=("exact_strong_v1",)),
    )


def test_evaluation_calculates_recall_reduction_and_duplicate_truth_pairs() -> None:
    a = [
        {"id": "A1", "phone": "5550101000"},
        {"id": "A2", "phone": "5550101000"},
        {"id": "A3", "phone": "5550109999"},
    ]
    b = [
        {"id": "B1", "telephone": "5550101000"},
        {"id": "B2", "telephone": "5550101000"},
        {"id": "B3", "telephone": "5550108888"},
    ]
    truth = {
        ("A1", "B1"),
        ("A1", "B2"),
        ("A2", "B1"),
        ("A2", "B2"),
    }
    report = evaluate_candidates(
        generated(a, b), truth, ["id", "phone"], a, ["id", "telephone"], b, [mapping()]
    )
    metrics = report["metrics"]
    assert metrics["theoreticalPairs"] == 9
    assert metrics["candidatePairs"] == 4
    assert metrics["reductionRatio"] == 2.25
    assert metrics["truePairsRetained"] == 4
    assert metrics["candidateRecall"] == 1
    assert metrics["candidatesByStrategy"] == {"exact_strong_v1": 4}
    assert metrics["uniqueCandidatesByStrategy"] == {"exact_strong_v1": 4}


def test_known_miss_and_no_candidates_produce_inspectable_diagnostic() -> None:
    a = [{"id": "A1", "phone": "5550101000"}]
    b = [{"id": "B1", "telephone": "5550101001"}]
    report = evaluate_candidates(
        generated(a, b),
        {("A1", "B1")},
        ["id", "phone"],
        a,
        ["id", "telephone"],
        b,
        [mapping()],
        provenance={("A", "A1"): ["one_digit_error"]},
    )
    metrics = report["metrics"]
    assert metrics["candidatePairs"] == 0
    assert metrics["reductionRatio"] is None
    assert metrics["candidateRecall"] == 0
    assert metrics["zeroCandidateARecords"] == 1
    miss = report["missedTrueMatches"][0]
    assert miss["aRowId"] == "A1"
    assert miss["visibleMappedValues"]["A"]["phone"]["normalized"] == "5550101000"
    assert miss["attemptedBlockers"][0]["reason"] == (
        "records emitted keys but none intersected"
    )
    assert miss["evaluationOnlyCorruptions"]["A"] == ["one_digit_error"]
