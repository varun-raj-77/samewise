"""Versioned evaluation snapshots, comparisons, gates, and error inspection.

This module is evaluation-only. Product matching never imports it and hidden truth is
opened only after candidate generation and scoring have completed.
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path
from typing import Any, Literal

from samewise_matcher.baseline import read_csv
from samewise_matcher.candidate_engine import CandidateEngineConfig, generate_candidates
from samewise_matcher.candidate_evaluation import load_truth_pairs
from samewise_matcher.explainable_matcher import MatcherConfig
from samewise_matcher.matcher_evaluation import (
    _baseline_scored,
    _classify,
    _quality_metrics,
    _rows_by_id,
    _score_bands,
    run_fixture_evaluation,
    score_generated_candidates,
)
from samewise_matcher.workflow_models import ManualMapping

EVALUATION_SNAPSHOT_VERSION = "evaluation-snapshot-v1.0.0"
EVALUATION_PRODUCT_VERSION = "matcher-evaluation-v0.3.0"
ERROR_TAXONOMY_VERSION = "evaluation-error-taxonomy-v1.0.0"
GATE_CONFIG_VERSION = "matcher-quality-gates-v1.0.0"
SOURCE_SYNTHETIC = "SYNTHETIC_GROUND_TRUTH"
SOURCE_HUMAN = "HUMAN_REVIEW_LABELS"


def _canonical_hash(value: Any) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 9) if denominator else None


def _metric(
    metric_id: str,
    label: str,
    numerator: int,
    denominator: int,
    *,
    level: Literal["pair", "a_row", "search_space"],
    description: str,
) -> dict[str, Any]:
    return {
        "id": metric_id,
        "label": label,
        "value": _ratio(numerator, denominator),
        "numerator": numerator,
        "denominator": denominator,
        "unit": "ratio",
        "level": level,
        "description": description,
    }


def _metrics(raw: dict[str, Any], fixture: dict[str, Any]) -> list[dict[str, Any]]:
    counts = fixture["actual_counts"]
    theoretical = counts["theoretical_cross_source_pairs"]
    candidate_pairs = raw["candidatePairs"]
    metrics = [
        _metric(
            "candidate_reduction_ratio",
            "Candidate reduction",
            theoretical - candidate_pairs,
            theoretical,
            level="search_space",
            description=(
                "Theoretical cross-source pairs not emitted as candidates / all "
                "theoretical cross-source pairs."
            ),
        ),
        _metric(
            "candidate_recall",
            "Candidate recall",
            raw["candidateTruePairs"],
            raw["truePairsTotal"],
            level="pair",
            description=(
                "True cross-source links retained as candidates / all true "
                "cross-source links."
            ),
        ),
        _metric(
            "feature_scoring_coverage",
            "Candidate-conditional feature scoring coverage",
            raw["scoredTruePairs"],
            raw["candidateTruePairs"],
            level="pair",
            description=(
                "True candidate links feature-scored / true links retained by "
                "candidate generation."
            ),
        ),
        _metric(
            "retained_link_coverage",
            "Candidate-conditional retained-link coverage",
            raw["retainedTruePairs"],
            raw["candidateTruePairs"],
            level="pair",
            description=(
                "True links retained for automatic or human decision / true links "
                "retained by candidate generation."
            ),
        ),
        _metric(
            "auto_match_precision",
            "Auto-match precision",
            raw["trueAutoMatches"],
            raw["autoMatchCount"],
            level="pair",
            description=(
                "True automatically linked pairs / all automatically linked pairs."
            ),
        ),
        _metric(
            "auto_match_recall",
            "Auto-match recall",
            raw["trueAutoMatches"],
            raw["truePairsTotal"],
            level="pair",
            description=(
                "True automatically linked pairs / all true cross-source links."
            ),
        ),
        _metric(
            "review_rate",
            "Review rate",
            raw["reviewRoutedARows"],
            raw["matchableARows"],
            level="a_row",
            description=(
                "Review-routed matchable A rows / A rows having one or more "
                "cross-source truth links."
            ),
        ),
        _metric(
            "end_to_end_recovery",
            "End-to-end true-link recovery",
            raw["retainedTruePairs"],
            raw["truePairsTotal"],
            level="pair",
            description=(
                "True links retained for automatic or human decision / all true "
                "cross-source links."
            ),
        ),
        _metric(
            "top1_true_candidate_rate",
            "Top-1 true-candidate rate",
            raw["top1TrueCandidateRows"],
            raw["top1EligibleRows"],
            level="a_row",
            description=(
                "Candidate-reached A rows whose top-ranked pair is true / "
                "candidate-reached matchable A rows."
            ),
        ),
    ]
    if any(
        item["value"] is not None and not 0 <= item["value"] <= 1 for item in metrics
    ):
        raise AssertionError("Evaluation percentages must remain bounded")
    return metrics


def _comparison_metrics(snapshot: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["id"]: item for item in snapshot["metrics"]}


def compare_snapshots(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    reasons: list[str] = []
    for path, label in (
        (("source", "type"), "label source type"),
        (("source", "id"), "fixture or label-set identity"),
        (("provenance", "datasetFingerprints"), "dataset fingerprints"),
        (("provenance", "candidateEngineVersion"), "candidate engine version"),
        (("provenance", "candidateConfigHash"), "candidate configuration"),
        (("evaluationVersion",), "evaluation semantics"),
    ):
        left_value: Any = left
        right_value: Any = right
        for key in path:
            left_value = left_value[key]
            right_value = right_value[key]
        if left_value != right_value:
            reasons.append(f"Different {label}.")
    compatible = not reasons
    rows: list[dict[str, Any]] = []
    left_metrics = _comparison_metrics(left)
    right_metrics = _comparison_metrics(right)
    for metric_id in sorted(left_metrics.keys() & right_metrics.keys()):
        a = left_metrics[metric_id]
        b = right_metrics[metric_id]
        delta = None
        if compatible and a["value"] is not None and b["value"] is not None:
            delta = round(b["value"] - a["value"], 9)
        rows.append(
            {
                "metricId": metric_id,
                "label": a["label"],
                "versionA": a["value"],
                "versionB": b["value"],
                "delta": delta,
                "deltaUnit": "percentage_points",
            }
        )
    return {
        "comparisonVersion": "evaluation-comparison-v1.0.0",
        "snapshotA": left["id"],
        "snapshotB": right["id"],
        "compatible": compatible,
        "status": "Comparable" if compatible else "Not directly comparable.",
        "reasons": reasons,
        "metrics": rows,
    }


def evaluate_gates(snapshot: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    values = _comparison_metrics(snapshot)
    counts = snapshot["counts"]
    checks = [
        {
            "id": "candidate_recall_minimum",
            "passed": values["candidate_recall"]["value"]
            >= config["minimumCandidateRecall"],
            "actual": values["candidate_recall"]["value"],
            "expected": config["minimumCandidateRecall"],
        },
        {
            "id": "false_auto_match_tolerance",
            "passed": counts["falseAutoMatches"] <= config["maximumFalseAutoMatches"],
            "actual": counts["falseAutoMatches"],
            "expected": config["maximumFalseAutoMatches"],
        },
        {
            "id": "hard_negative_auto_match_tolerance",
            "passed": counts["hardNegativeAutoMatches"]
            <= config["maximumHardNegativeAutoMatches"],
            "actual": counts["hardNegativeAutoMatches"],
            "expected": config["maximumHardNegativeAutoMatches"],
        },
        {
            "id": "auto_match_precision_minimum",
            "passed": values["auto_match_precision"]["value"] is not None
            and values["auto_match_precision"]["value"]
            >= config["minimumAutoMatchPrecision"],
            "actual": values["auto_match_precision"]["value"],
            "expected": config["minimumAutoMatchPrecision"],
        },
        {
            "id": "candidate_ceiling_invariant",
            "passed": values["end_to_end_recovery"]["value"]
            <= values["candidate_recall"]["value"],
            "actual": values["end_to_end_recovery"]["value"],
            "expected": values["candidate_recall"]["value"],
        },
    ]
    return {
        "configVersion": config["configVersion"],
        "passed": all(check["passed"] for check in checks),
        "checks": checks,
    }


def _record(rows: dict[str, dict[str, str]], row_id: str) -> dict[str, str]:
    return rows.get(row_id, {})


def _error(
    error_id: str,
    group: str,
    category: str,
    a_row_id: str,
    b_row_id: str,
    a_rows: dict[str, dict[str, str]],
    b_rows: dict[str, dict[str, str]],
    **details: Any,
) -> dict[str, Any]:
    return {
        "id": error_id,
        "group": group,
        "taxonomyVersion": ERROR_TAXONOMY_VERSION,
        "category": category,
        "aRowId": a_row_id,
        "bRowId": b_row_id,
        "aRecord": _record(a_rows, a_row_id),
        "bRecord": _record(b_rows, b_row_id),
        "evaluationOnlyTruth": {
            "label": "SAME" if group != "hard_negatives" else "DIFFERENT",
            "notice": "Evaluation-only truth. This was not matcher input.",
        },
        **details,
    }


def _build_snapshot(
    report: dict[str, Any],
    matcher_version: str,
    raw_metrics: dict[str, Any],
    *,
    score_bands: list[dict[str, Any]],
    threshold_analysis: list[dict[str, Any]],
    errors: list[dict[str, Any]],
    gate_config: dict[str, Any],
) -> dict[str, Any]:
    fixture = report["fixture"]
    matcher_config = report["matcherConfig"]
    candidate_config = report["candidateConfig"]
    dataset_fingerprints = {
        side: fixture["artifacts"][side]["sha256"]
        for side in ("dataset_a", "dataset_b")
    }
    snapshot: dict[str, Any] = {
        "snapshotVersion": EVALUATION_SNAPSHOT_VERSION,
        "evaluationVersion": EVALUATION_PRODUCT_VERSION,
        "source": {
            "type": SOURCE_SYNTHETIC,
            "id": fixture["fixture_name"],
            "label": "Synthetic benchmark ground truth",
            "representative": False,
            "caveat": (
                "Synthetic fixture evidence does not establish real-data quality."
            ),
        },
        "fixture": {
            "name": fixture["fixture_name"],
            "seed": fixture["seed"],
            "aRows": fixture["actual_counts"]["visible_rows_a"],
            "bRows": fixture["actual_counts"]["visible_rows_b"],
            "theoreticalPairs": fixture["actual_counts"][
                "theoretical_cross_source_pairs"
            ],
        },
        "provenance": {
            "datasetFingerprints": dataset_fingerprints,
            "mappingVersion": "organizations-confirmed-mappings-v1",
            "candidateEngineVersion": report["candidateEngineVersion"],
            "candidateConfigHash": _canonical_hash(candidate_config),
            "featurePipelineVersion": report["featurePipelineVersion"],
            "matcherVersion": matcher_version,
            "matcherConfigVersion": (
                matcher_config["configVersion"]
                if matcher_version == report["matcherVersion"]
                else "baseline-matcher-config-v0.1.0"
            ),
            "matcherConfigHash": _canonical_hash(
                matcher_config
                if matcher_version == report["matcherVersion"]
                else {
                    "autoMatchThreshold": 0.82,
                    "reviewThreshold": 0.38,
                    "minimumTopCandidateMargin": 0.08,
                    "maxAlternatives": 3,
                }
            ),
        },
        "metrics": _metrics(raw_metrics, fixture),
        "counts": {
            "candidatePairs": raw_metrics["candidatePairs"],
            "trueLinks": raw_metrics["truePairsTotal"],
            "candidateMisses": raw_metrics["candidateMisses"],
            "featureScoredTrueLinks": raw_metrics["scoredTruePairs"],
            "postCandidateLosses": raw_metrics["postScoreRetentionMisses"]
            + raw_metrics["belowReviewThresholdTruePairs"],
            "recoverableTrueLinks": raw_metrics["retainedTruePairs"],
            "autoMatches": raw_metrics["autoMatchCount"],
            "trueAutoMatches": raw_metrics["trueAutoMatches"],
            "falseAutoMatches": raw_metrics["falseAutoMatches"],
            "reviewRoutedARows": raw_metrics["reviewRoutedARows"],
            "unmatchedMatchableARows": raw_metrics["unmatchedMatchableARows"],
            "hardNegativeAutoMatches": raw_metrics.get("hardNegativeAutoMatches", 0),
        },
        "decomposition": {
            "pairLevel": {
                "trueLinks": raw_metrics["truePairsTotal"],
                "candidateRetained": raw_metrics["candidateTruePairs"],
                "featureScored": raw_metrics["scoredTruePairs"],
                "recoverable": raw_metrics["retainedTruePairs"],
                "autoMatched": raw_metrics["trueAutoMatches"],
            },
            "aRowLevel": {
                "matchable": raw_metrics["matchableARows"],
                "autoMatched": raw_metrics["autoMatchedARows"],
                "reviewRouted": raw_metrics["reviewRoutedARows"],
                "unmatched": raw_metrics["unmatchedMatchableARows"],
            },
        },
        "scoreBands": score_bands,
        "scoreBandNotice": (
            "Empirical match rates on this frozen fixture; scores are not "
            "calibrated probabilities."
        ),
        "thresholdAnalysis": threshold_analysis,
        "thresholdAnalysisNotice": (
            "Retrospective analysis only. Other matcher policies remain fixed and "
            "production configuration is not changed."
        ),
        "errorSummary": {
            group: sum(error["group"] == group for error in errors)
            for group in (
                "candidate_misses",
                "ranking_losses",
                "post_score_losses",
                "false_auto_matches",
                "false_unmatched",
                "hard_negatives",
            )
        },
        "gateResult": None,
        "artifactHashes": {
            "sw006Report": _canonical_hash(report),
            "errors": _canonical_hash(errors),
        },
    }
    snapshot["gateResult"] = evaluate_gates(snapshot, gate_config)
    content_hash = _canonical_hash(snapshot)
    snapshot["contentHash"] = content_hash
    snapshot["id"] = (
        f"{fixture['fixture_name']}--{matcher_version}--{content_hash[:12]}"
    )
    return snapshot


def run_evaluation_product(
    root: Path,
    fixture_name: str,
    mappings: list[ManualMapping],
    candidate_config: CandidateEngineConfig,
    matcher_config: MatcherConfig,
    gate_config: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]], dict[str, Any]]:
    """Run visible matching, then build immutable evaluation-only artifacts."""

    report, _ = run_fixture_evaluation(
        root,
        fixture_name,
        mappings,
        candidate_config,
        matcher_config,
        phase="holdout",
    )
    manifest = report["fixture"]

    def artifact(name: str) -> Path:
        return root / manifest["artifacts"][name]["path"]

    a_headers, a_data = read_csv(artifact("dataset_a"))
    b_headers, b_data = read_csv(artifact("dataset_b"))
    generation = generate_candidates(
        a_headers, a_data, b_headers, b_data, mappings, candidate_config
    )
    current_scored = score_generated_candidates(
        generation,
        a_headers,
        a_data,
        b_headers,
        b_data,
        mappings,
        matcher_config,
    )
    baseline_scored = _baseline_scored(
        generation, a_headers, a_data, b_headers, b_data, mappings
    )

    # Absolute truth boundary: hidden truth is opened only after both versions finish.
    truth_pairs = load_truth_pairs(artifact("identity_truth"))
    a_rows = _rows_by_id(a_headers, a_data, "A")
    b_rows = _rows_by_id(b_headers, b_data, "B")
    candidate_pairs = {
        (candidate.aRowId, candidate.bRowId) for candidate in generation.candidates
    }
    current_classified = _classify(current_scored, matcher_config.decisions)
    scored_by_pair = {(item.aRowId, item.bRowId): item for item in current_scored}
    errors: list[dict[str, Any]] = []
    for index, (a_id, b_id) in enumerate(sorted(truth_pairs - candidate_pairs)):
        errors.append(
            _error(
                f"candidate-miss-{index + 1}",
                "candidate_misses",
                "candidate_no_shared_key",
                a_id,
                b_id,
                a_rows,
                b_rows,
                failureStage="candidate_generation",
                failureReason="True link did not reach feature scoring.",
                blockingEvidence=[],
            )
        )
    for index, item in enumerate(report["rankingMisses"]):
        errors.append(
            _error(
                f"ranking-loss-{index + 1}",
                "ranking_losses",
                "ranking_wrong_top1",
                item["aRowId"],
                item["bestTrueBRowId"],
                a_rows,
                b_rows,
                failureStage="ranking",
                failureReason="A false candidate ranked above the best true candidate.",
                score=item["bestTrueScore"],
                evidence=item["bestTrueEvidence"],
                competingCandidate={
                    "bRowId": item["falseTopBRowId"],
                    "score": item["falseTopScore"],
                    "record": _record(b_rows, item["falseTopBRowId"]),
                    "evidence": item["falseTopEvidence"],
                },
            )
        )
    for index, item in enumerate(report["postScoreRetentionLosses"]):
        errors.append(
            _error(
                f"post-score-loss-{index + 1}",
                "post_score_losses",
                (
                    "retention_top_n"
                    if item["reason"] == "top_n_alternative_limit"
                    else "retention_threshold"
                ),
                item["aRowId"],
                item["bRowId"],
                a_rows,
                b_rows,
                failureStage="post_score_retention",
                failureReason=item["reason"],
                score=item["matchScore"],
                rank=item["rank"],
                evidence=[
                    evidence.model_dump(mode="json")
                    for evidence in scored_by_pair[
                        (item["aRowId"], item["bRowId"])
                    ].evidence
                ],
            )
        )
    for index, item in enumerate(report["hardNegatives"]):
        pair = (item["aRowId"], item["bRowId"])
        scored = scored_by_pair[pair]
        errors.append(
            _error(
                f"hard-negative-{index + 1}",
                "hard_negatives",
                "hard_negative_case",
                item["aRowId"],
                item["bRowId"],
                a_rows,
                b_rows,
                failureStage="adversarial_check",
                failureReason=item["pattern"],
                score=item["matchScore"],
                rank=item["rank"],
                autoMatched=item["autoMatched"],
                evidence=[
                    evidence.model_dump(mode="json") for evidence in scored.evidence
                ],
                blockingEvidence=[
                    evidence.model_dump(mode="json")
                    for evidence in scored.blockingEvidence
                ],
            )
        )
    for a_id, decision in sorted(current_classified.items()):
        top = decision["top"]
        if decision["band"] == "auto_match" and (a_id, top.bRowId) not in truth_pairs:
            errors.append(
                _error(
                    f"false-auto-{a_id}-{top.bRowId}",
                    "false_auto_matches",
                    "auto_match_false_positive",
                    a_id,
                    top.bRowId,
                    a_rows,
                    b_rows,
                    failureStage="decision_policy",
                    failureReason=(
                        "Automatically linked pair is false in fixture truth."
                    ),
                    score=top.matchScore,
                    evidence=[
                        evidence.model_dump(mode="json") for evidence in top.evidence
                    ],
                )
            )

    retained_pairs = {
        (item.aRowId, item.bRowId)
        for decision in current_classified.values()
        for item in decision["retained"]
    }
    truth_by_a: dict[str, list[str]] = {}
    for a_id, b_id in sorted(truth_pairs):
        truth_by_a.setdefault(a_id, []).append(b_id)
    for a_id, true_b_ids in sorted(truth_by_a.items()):
        if any((a_id, b_id) in retained_pairs for b_id in true_b_ids):
            continue
        candidate_truth = [
            b_id for b_id in true_b_ids if (a_id, b_id) in candidate_pairs
        ]
        b_id = candidate_truth[0] if candidate_truth else true_b_ids[0]
        scored = scored_by_pair.get((a_id, b_id))
        errors.append(
            _error(
                f"false-unmatched-{a_id}",
                "false_unmatched",
                (
                    "unmatched_decision_policy"
                    if candidate_truth
                    else "unmatched_candidate_miss"
                ),
                a_id,
                b_id,
                a_rows,
                b_rows,
                failureStage=(
                    "decision_coverage" if candidate_truth else "candidate_generation"
                ),
                failureReason=(
                    "Matchable A row has no true pair retained for decision coverage."
                ),
                score=scored.matchScore if scored else None,
                evidence=(
                    [evidence.model_dump(mode="json") for evidence in scored.evidence]
                    if scored
                    else []
                ),
            )
        )

    all_a = set(a_rows)
    threshold_analysis: list[dict[str, Any]] = []
    for threshold in (0.45, 0.50, 0.55, 0.60, 0.65):
        rules = matcher_config.decisions.model_copy(
            update={"autoMatchThreshold": threshold}
        )
        metrics, _ = _quality_metrics(current_scored, truth_pairs, all_a, rules)
        threshold_analysis.append(
            {
                "threshold": threshold,
                "autoMatchCount": metrics["autoMatchCount"],
                "autoMatchPrecision": metrics["autoMatchPrecision"],
                "autoMatchRecall": metrics["autoMatchRecall"],
                "reviewRate": metrics["reviewRate"],
                "falseAutoMatches": metrics["falseAutoMatches"],
            }
        )

    baseline_raw = deepcopy(report["baselineComparison"]["metrics"])
    baseline_raw["hardNegativeAutoMatches"] = report["baselineComparison"][
        "hardNegativeAutoMatches"
    ]
    baseline = _build_snapshot(
        report,
        "baseline-matcher-v0.1.0",
        baseline_raw,
        score_bands=_score_bands(baseline_scored, truth_pairs),
        threshold_analysis=[],
        errors=[],
        gate_config=gate_config,
    )
    current = _build_snapshot(
        report,
        report["matcherVersion"],
        report["metrics"],
        score_bands=_score_bands(current_scored, truth_pairs),
        threshold_analysis=threshold_analysis,
        errors=errors,
        gate_config=gate_config,
    )
    comparison = compare_snapshots(baseline, current)
    error_sets = {current["id"]: errors, baseline["id"]: []}
    return [baseline, current], error_sets, comparison


def write_evaluation_artifacts(
    output_dir: Path,
    snapshots: list[dict[str, Any]],
    errors: dict[str, list[dict[str, Any]]],
    comparison: dict[str, Any],
    related_benchmarks: list[dict[str, Any]],
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for snapshot in snapshots:
        snapshot_dir = output_dir / snapshot["id"]
        snapshot_dir.mkdir(parents=True, exist_ok=True)
        (snapshot_dir / "snapshot.json").write_text(
            json.dumps(snapshot, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        (snapshot_dir / "errors.json").write_text(
            json.dumps(errors[snapshot["id"]], indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    catalog = {
        "catalogVersion": "evaluation-catalog-v1.0.0",
        "snapshots": snapshots,
        "comparisons": [comparison],
        "relatedBenchmarks": related_benchmarks,
    }
    (output_dir / "catalog.json").write_text(
        json.dumps(catalog, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (output_dir / "comparison.json").write_text(
        json.dumps(comparison, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (output_dir / "comparison.md").write_text(
        markdown_comparison(comparison), encoding="utf-8"
    )


def load_weak_identifier_evidence(root: Path) -> dict[str, Any]:
    report = json.loads(
        (
            root
            / "evaluation"
            / "reports"
            / "sw-005f"
            / "falsification-report-v0.2.0.json"
        ).read_text(encoding="utf-8")
    )
    current = next(
        item
        for item in report["engineComparison"]
        if item["engine"] == "candidate-engine-v0.2.0"
    )
    return {
        "id": "sw-005f-weak-identifiers-v0.2.0",
        "title": "SW-005F weak-identifier falsification",
        "sourceType": SOURCE_SYNTHETIC,
        "fixtureName": report["fixture"]["name"],
        "evaluationVersion": report["reportVersion"],
        "candidateEngineVersion": current["engine"],
        "candidateCount": current["candidatePairs"],
        "candidateRecall": {
            "numerator": current["truePairsRetained"],
            "denominator": report["fixture"]["truePairs"],
            "value": current["candidateRecall"],
        },
        "weakIdentifierRecall": {
            "numerator": current["weakTruePairsRetained"],
            "denominator": current["weakTruePairsTotal"],
            "value": current["weakCandidateRecall"],
        },
        "caveat": (
            "Candidate-stage adversarial evidence only; this does not report final "
            "matcher precision or recall."
        ),
    }


def markdown_comparison(comparison: dict[str, Any]) -> str:
    def display(value: float | None) -> str:
        return "—" if value is None else f"{value * 100:.6f}%"

    rows = [
        "# Matcher evaluation comparison",
        "",
        f"Compatibility: **{comparison['status']}**",
        "",
        "| Metric | Version A | Version B | Delta |",
        "| --- | ---: | ---: | ---: |",
    ]
    for metric in comparison["metrics"]:
        delta = "—" if metric["delta"] is None else f"{metric['delta'] * 100:+.6f} pp"
        rows.append(
            f"| {metric['label']} | {display(metric['versionA'])} | "
            f"{display(metric['versionB'])} | {delta} |"
        )
    rows.extend(["", "No automated winner is declared; deltas are tradeoffs.", ""])
    return "\n".join(rows)
