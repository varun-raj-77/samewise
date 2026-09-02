import json
from copy import deepcopy
from pathlib import Path

from samewise_matcher.cli import main
from samewise_matcher.evaluation_product import compare_snapshots, evaluate_gates

ROOT = Path(__file__).parents[3]
CATALOG_PATH = ROOT / "evaluation" / "reports" / "sw-009" / "catalog.json"


def _snapshots() -> tuple[dict, dict]:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    by_matcher = {
        snapshot["provenance"]["matcherVersion"]: snapshot
        for snapshot in catalog["snapshots"]
    }
    return (
        by_matcher["baseline-matcher-v0.1.0"],
        by_matcher["explainable-matcher-v0.2.0"],
    )


def test_frozen_snapshot_reproduces_sw006_denominators_and_gates() -> None:
    _, current = _snapshots()
    metrics = {metric["id"]: metric for metric in current["metrics"]}
    assert (
        metrics["candidate_recall"]["numerator"],
        metrics["candidate_recall"]["denominator"],
    ) == (866, 879)
    assert (
        metrics["auto_match_precision"]["numerator"],
        metrics["auto_match_precision"]["denominator"],
    ) == (253, 253)
    assert (
        metrics["review_rate"]["numerator"],
        metrics["review_rate"]["denominator"],
    ) == (598, 858)
    assert (
        metrics["end_to_end_recovery"]["numerator"],
        metrics["end_to_end_recovery"]["denominator"],
    ) == (864, 879)
    assert (
        metrics["end_to_end_recovery"]["value"] <= metrics["candidate_recall"]["value"]
    )
    assert current["gateResult"]["passed"] is True
    assert all(
        band["candidateCount"] == band["trueMatchCount"] + band["falseMatchCount"]
        for band in current["scoreBands"]
    )


def test_compatible_comparison_preserves_undefined_precision_and_pp_delta() -> None:
    baseline, current = _snapshots()
    comparison = compare_snapshots(baseline, current)
    rows = {row["metricId"]: row for row in comparison["metrics"]}
    assert comparison["compatible"] is True
    assert rows["auto_match_precision"]["versionA"] is None
    assert rows["auto_match_precision"]["delta"] is None
    assert rows["review_rate"]["delta"] == -0.294871795
    assert rows["top1_true_candidate_rate"]["delta"] == 0.017730496


def test_incompatible_fixture_and_source_are_not_directly_compared() -> None:
    baseline, current = _snapshots()
    changed = deepcopy(current)
    changed["source"]["type"] = "HUMAN_REVIEW_LABELS"
    changed["source"]["id"] = "reviewed-run-1"
    comparison = compare_snapshots(baseline, changed)
    assert comparison["compatible"] is False
    assert comparison["status"] == "Not directly comparable."
    assert all(row["delta"] is None for row in comparison["metrics"])


def test_gate_result_is_deterministic_and_does_not_require_exact_metrics() -> None:
    _, current = _snapshots()
    config = json.loads(
        (
            ROOT / "evaluation" / "configs" / "matcher-quality-gates-v1.0.0.json"
        ).read_text(encoding="utf-8")
    )
    assert evaluate_gates(current, config) == evaluate_gates(current, config)


def test_error_artifact_marks_truth_as_evaluation_only() -> None:
    _, current = _snapshots()
    errors_path = CATALOG_PATH.parent / current["id"] / "errors.json"
    errors = json.loads(errors_path.read_text(encoding="utf-8"))
    assert sum(error["group"] == "candidate_misses" for error in errors) == 13
    false_unmatched = [error for error in errors if error["group"] == "false_unmatched"]
    assert len(false_unmatched) == 14
    assert {error["category"] for error in false_unmatched} <= {
        "unmatched_candidate_miss",
        "unmatched_decision_policy",
    }
    assert sum(error["group"] == "hard_negatives" for error in errors) == 6
    assert all(
        "Evaluation-only truth" in error["evaluationOnlyTruth"]["notice"]
        for error in errors
    )


def test_comparison_and_error_inspection_cli(tmp_path: Path, capsys) -> None:
    baseline, current = _snapshots()
    left = tmp_path / "left.json"
    right = tmp_path / "right.json"
    left.write_text(json.dumps(baseline), encoding="utf-8")
    right.write_text(json.dumps(current), encoding="utf-8")
    output = tmp_path / "comparison"
    assert (
        main(
            [
                "evaluation",
                "compare",
                "--snapshot-a",
                str(left),
                "--snapshot-b",
                str(right),
                "--output-dir",
                str(output),
            ]
        )
        == 0
    )
    assert json.loads((output / "comparison.json").read_text())["compatible"]
    capsys.readouterr()
    errors_path = CATALOG_PATH.parent / current["id"] / "errors.json"
    assert (
        main(
            [
                "evaluation",
                "inspect-errors",
                "--errors",
                str(errors_path),
                "--type",
                "hard_negatives",
            ]
        )
        == 0
    )
    inspected = json.loads(capsys.readouterr().out)
    assert len(inspected) == 6
