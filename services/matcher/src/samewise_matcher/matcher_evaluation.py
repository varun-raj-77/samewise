"""Evaluation-only tuning and held-out analysis for explainable matching."""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Literal

from samewise_matcher.baseline import compare_field
from samewise_matcher.candidate_engine import (
    CandidateEngineConfig,
    CandidateGenerationResult,
    generate_candidates,
)
from samewise_matcher.candidate_evaluation import load_truth_pairs
from samewise_matcher.explainable_matcher import (
    DecisionRules,
    MatcherConfig,
    ScoredPair,
)
from samewise_matcher.explainable_matcher import (
    score_generated_candidates as score_visible_candidates,
)
from samewise_matcher.workflow_models import BlockingEvidenceView, ManualMapping

MATCHER_EVALUATION_VERSION = "matcher-evaluation-v0.2.0"
MINIMUM_TUNING_AUTO_PRECISION = 0.995


def _rows_by_id(
    headers: list[str], rows: list[dict[str, str]], side: str
) -> dict[str, dict[str, str]]:
    return {
        row.get(headers[0], "").strip() or f"{side}-{index + 1}": row
        for index, row in enumerate(rows)
    }


def score_generated_candidates(
    generation: CandidateGenerationResult,
    a_headers: list[str],
    a_rows: list[dict[str, str]],
    b_headers: list[str],
    b_rows: list[dict[str, str]],
    mappings: list[ManualMapping],
    config: MatcherConfig,
) -> list[ScoredPair]:
    """Score visible candidates before any hidden truth is joined."""

    identity = [mapping for mapping in mappings if mapping.role == "identity"]
    a_by_id = _rows_by_id(a_headers, a_rows, "A")
    b_by_id = _rows_by_id(b_headers, b_rows, "B")
    return score_visible_candidates(
        generation.candidates, a_by_id, b_by_id, identity, config
    )


def _rank(scored: list[ScoredPair]) -> dict[str, list[ScoredPair]]:
    output: dict[str, list[ScoredPair]] = defaultdict(list)
    for item in scored:
        output[item.aRowId].append(item)
    for items in output.values():
        items.sort(key=lambda item: (-item.matchScore, item.bRowId))
    return dict(output)


def _classify(
    scored: list[ScoredPair],
    rules: DecisionRules,
    *,
    enforce_contradictions: bool = True,
    enforce_agreement_count: bool = True,
) -> dict[str, dict[str, Any]]:
    ranked = _rank(scored)
    preferred = Counter(
        items[0].bRowId
        for items in ranked.values()
        if items[0].matchScore >= rules.reviewThreshold
    )
    output: dict[str, dict[str, Any]] = {}
    for a_row_id, items in ranked.items():
        top = items[0]
        runner_up = items[1].matchScore if len(items) > 1 else 0.0
        margin = round(max(0.0, top.matchScore - runner_up), 6)
        collision = preferred[top.bRowId] > 1
        auto = (
            top.matchScore >= rules.autoMatchThreshold
            and margin >= rules.minimumTopCandidateMargin
            and not collision
            and (not enforce_contradictions or not top.strongContradiction)
            and (
                not enforce_agreement_count
                or top.agreementFields >= rules.minimumAutoAgreementFields
            )
        )
        if auto:
            band = "auto_match"
        elif top.matchScore >= rules.reviewThreshold:
            band = "needs_review"
        else:
            band = "unmatched"
        cutoff = max(rules.alternativeFloor, top.matchScore - rules.alternativeWindow)
        retained = (
            [item for item in items if item.matchScore >= cutoff][
                : rules.maxAlternatives
            ]
            if band != "unmatched"
            else []
        )
        output[a_row_id] = {
            "band": band,
            "top": top,
            "margin": margin,
            "collision": collision,
            "retained": retained,
        }
    return output


def _safe_ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 9) if denominator else None


def _score_bands(
    scored: list[ScoredPair], truth_pairs: set[tuple[str, str]]
) -> list[dict[str, int | float | str | None]]:
    output: list[dict[str, int | float | str | None]] = []
    for index in range(10):
        lower = index / 10
        upper = (index + 1) / 10
        items = [
            item
            for item in scored
            if item.matchScore >= lower
            and (item.matchScore < upper or index == 9 and item.matchScore <= upper)
        ]
        true_count = sum((item.aRowId, item.bRowId) in truth_pairs for item in items)
        output.append(
            {
                "band": f"{lower:.1f}-{upper:.1f}",
                "candidateCount": len(items),
                "trueMatchCount": true_count,
                "falseMatchCount": len(items) - true_count,
                "empiricalMatchRate": _safe_ratio(true_count, len(items)),
            }
        )
    return output


def _hard_negative_pairs(
    truth_payload: dict[str, Any], hard_negative_payload: dict[str, Any]
) -> dict[tuple[str, str], str]:
    by_entity_a: dict[str, list[str]] = defaultdict(list)
    by_entity_b: dict[str, list[str]] = defaultdict(list)
    for item in truth_payload["source_a"]:
        by_entity_a[item["canonical_entity_id"]].append(item["source_row_id"])
    for item in truth_payload["source_b"]:
        by_entity_b[item["canonical_entity_id"]].append(item["source_row_id"])
    output: dict[tuple[str, str], str] = {}
    for pattern in hard_negative_payload["patterns"]:
        left = pattern["left_canonical_entity_id"]
        right = pattern["right_canonical_entity_id"]
        for a_id in by_entity_a[left]:
            for b_id in by_entity_b[right]:
                output[(a_id, b_id)] = pattern["pattern"]
        for a_id in by_entity_a[right]:
            for b_id in by_entity_b[left]:
                output[(a_id, b_id)] = pattern["pattern"]
    return output


def _baseline_scored(
    generation: CandidateGenerationResult,
    a_headers: list[str],
    a_rows: list[dict[str, str]],
    b_headers: list[str],
    b_rows: list[dict[str, str]],
    mappings: list[ManualMapping],
) -> list[ScoredPair]:
    identity = [mapping for mapping in mappings if mapping.role == "identity"]
    a_by_id = _rows_by_id(a_headers, a_rows, "A")
    b_by_id = _rows_by_id(b_headers, b_rows, "B")
    output: list[ScoredPair] = []
    for candidate in generation.candidates:
        evidence = [
            compare_field(
                mapping,
                a_by_id[candidate.aRowId][mapping.aColumn],
                b_by_id[candidate.bRowId][mapping.bColumn],
            )
            for mapping in identity
        ]
        score = round(sum(item.contribution for item in evidence) / len(identity), 6)
        output.append(
            ScoredPair(
                aRowId=candidate.aRowId,
                bRowId=candidate.bRowId,
                matchScore=score,
                positiveEvidence=round(sum(item.contribution for item in evidence), 6),
                conflictEvidence=0.0,
                totalWeight=float(len(identity)),
                agreementFields=sum(item.contribution > 0 for item in evidence),
                strongContradiction=False,
                evidence=evidence,
                blockingEvidence=[
                    BlockingEvidenceView.model_validate(item.model_dump())
                    for item in candidate.blockingEvidence
                ],
            )
        )
    return output


def _quality_metrics(
    scored: list[ScoredPair],
    truth_pairs: set[tuple[str, str]],
    all_a_row_ids: set[str],
    rules: DecisionRules,
    *,
    enforce_contradictions: bool = True,
    enforce_agreement_count: bool = True,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    classified = _classify(
        scored,
        rules,
        enforce_contradictions=enforce_contradictions,
        enforce_agreement_count=enforce_agreement_count,
    )
    scored_by_pair = {(item.aRowId, item.bRowId): item for item in scored}
    candidate_pairs = {(item.aRowId, item.bRowId) for item in scored}
    reached_truth = truth_pairs & candidate_pairs
    candidate_misses = truth_pairs - candidate_pairs
    review_threshold_covered_truth = {
        pair
        for pair in reached_truth
        if scored_by_pair[pair].matchScore >= rules.reviewThreshold
    }
    below_review_threshold_truth = reached_truth - review_threshold_covered_truth
    retained_pairs = {
        (item.aRowId, item.bRowId)
        for decision in classified.values()
        for item in decision["retained"]
    }
    post_score_retention_misses = review_threshold_covered_truth - retained_pairs
    recovered_truth = truth_pairs & retained_pairs
    recovered_a = {a_id for a_id, _ in recovered_truth}
    auto = [
        decision["top"]
        for decision in classified.values()
        if decision["band"] == "auto_match"
    ]
    true_auto = [item for item in auto if (item.aRowId, item.bRowId) in truth_pairs]
    relevant_a = {a_id for a_id, _ in truth_pairs}
    review_a = {
        a_id
        for a_id, decision in classified.items()
        if a_id in relevant_a and decision["band"] == "needs_review"
    }
    auto_a = {
        a_id
        for a_id, decision in classified.items()
        if a_id in relevant_a and decision["band"] == "auto_match"
    }
    unmatched_a = relevant_a - auto_a - review_a
    truth_uncovered_a = relevant_a - recovered_a
    reached_truth_a = {a_id for a_id, _ in reached_truth}
    top_true = sum(
        (decision["top"].aRowId, decision["top"].bRowId) in truth_pairs
        for a_id, decision in classified.items()
        if a_id in reached_truth_a
    )
    metrics = {
        "candidatePairs": len(candidate_pairs),
        "truePairsTotal": len(truth_pairs),
        "candidateTruePairs": len(reached_truth),
        "candidateMisses": len(candidate_misses),
        "candidateRecall": _safe_ratio(len(reached_truth), len(truth_pairs)),
        "scoredTruePairs": len(reached_truth),
        "candidateConditionalFeatureScoringCoverage": _safe_ratio(
            len(reached_truth), len(reached_truth)
        ),
        "truePairsAtOrAboveReviewThreshold": len(review_threshold_covered_truth),
        "belowReviewThresholdTruePairs": len(below_review_threshold_truth),
        "candidateConditionalReviewThresholdCoverage": _safe_ratio(
            len(review_threshold_covered_truth), len(reached_truth)
        ),
        "postScoreRetentionMisses": len(post_score_retention_misses),
        "autoMatchCount": len(auto),
        "trueAutoMatches": len(true_auto),
        "falseAutoMatches": len(auto) - len(true_auto),
        "autoMatchPrecision": _safe_ratio(len(true_auto), len(auto)),
        "autoMatchRecall": _safe_ratio(len(true_auto), len(truth_pairs)),
        "matchableARows": len(relevant_a),
        "autoMatchedARows": len(auto_a),
        "reviewRoutedARows": len(review_a),
        "unmatchedMatchableARows": len(unmatched_a),
        "recoverableMatchableARows": len(recovered_a),
        "truthUncoveredARows": len(truth_uncovered_a),
        "truthUncoveredAutoRows": len(truth_uncovered_a & auto_a),
        "truthUncoveredReviewRows": len(truth_uncovered_a & review_a),
        "truthUncoveredUnmatchedRows": len(truth_uncovered_a & unmatched_a),
        "reviewRateDenominator": "A rows with at least one cross-source truth link",
        "reviewRateDenominatorCount": len(relevant_a),
        "reviewRate": _safe_ratio(len(review_a), len(relevant_a)),
        "retainedTruePairs": len(recovered_truth),
        "candidateConditionalRetentionRate": _safe_ratio(
            len(recovered_truth), len(reached_truth)
        ),
        "endToEndRecovery": _safe_ratio(len(recovered_truth), len(truth_pairs)),
        "top1TrueCandidateRows": top_true,
        "top1EligibleRows": len(reached_truth_a),
        "top1TrueCandidateRate": _safe_ratio(top_true, len(reached_truth_a)),
        "sourceOnlyARows": len(all_a_row_ids - relevant_a),
    }
    if (
        metrics["endToEndRecovery"] is not None
        and metrics["candidateRecall"] is not None
        and metrics["endToEndRecovery"] > metrics["candidateRecall"]
    ):
        raise AssertionError("End-to-end recovery cannot exceed candidate recall")
    if len(candidate_misses) + len(reached_truth) != len(truth_pairs):
        raise AssertionError("Candidate miss decomposition does not reconcile")
    if len(below_review_threshold_truth) + len(review_threshold_covered_truth) != len(
        reached_truth
    ):
        raise AssertionError("Review-threshold decomposition does not reconcile")
    if len(auto_a) + len(review_a) + len(unmatched_a) != len(relevant_a):
        raise AssertionError("Matchable A-row state decomposition does not reconcile")
    return metrics, classified


def _post_score_retention_losses(
    scored: list[ScoredPair],
    truth_pairs: set[tuple[str, str]],
    classified: dict[str, dict[str, Any]],
    rules: DecisionRules,
) -> list[dict[str, Any]]:
    """Explain true pairs that scored above review threshold but were not retained."""

    ranked = _rank(scored)
    scored_by_pair = {(item.aRowId, item.bRowId): item for item in scored}
    retained_pairs = {
        (item.aRowId, item.bRowId)
        for decision in classified.values()
        for item in decision["retained"]
    }
    losses: list[dict[str, Any]] = []
    for a_row_id, b_row_id in sorted(truth_pairs):
        item = scored_by_pair.get((a_row_id, b_row_id))
        if (
            item is None
            or item.matchScore < rules.reviewThreshold
            or (a_row_id, b_row_id) in retained_pairs
        ):
            continue
        decision = classified[a_row_id]
        items = ranked[a_row_id]
        rank = next(
            index
            for index, ranked_item in enumerate(items, start=1)
            if ranked_item.bRowId == b_row_id
        )
        cutoff = max(
            rules.alternativeFloor,
            decision["top"].matchScore - rules.alternativeWindow,
        )
        if item.matchScore < cutoff:
            reason = "alternative_score_cutoff"
        elif rank > rules.maxAlternatives:
            reason = "top_n_alternative_limit"
        else:
            raise AssertionError(
                "A review-eligible true pair was unexpectedly discarded"
            )
        losses.append(
            {
                "aRowId": a_row_id,
                "bRowId": b_row_id,
                "generated": True,
                "matchScore": item.matchScore,
                "rank": rank,
                "reason": reason,
                "decisionBand": decision["band"],
                "topScore": decision["top"].matchScore,
                "topCandidateMargin": decision["margin"],
                "collision": decision["collision"],
                "reviewThreshold": rules.reviewThreshold,
                "retentionCutoff": round(cutoff, 6),
                "maxAlternatives": rules.maxAlternatives,
            }
        )
    return losses


def select_thresholds(
    scored: list[ScoredPair],
    truth_pairs: set[tuple[str, str]],
    all_a_row_ids: set[str],
    template: MatcherConfig,
) -> tuple[MatcherConfig, dict[str, Any]]:
    """Choose conservative thresholds using tuning truth only."""

    candidates: list[tuple[tuple[Any, ...], DecisionRules, dict[str, Any]]] = []
    for review_integer in range(20, 51, 5):
        review = review_integer / 100
        for auto_integer in range(50, 99, 2):
            auto = auto_integer / 100
            if review >= auto:
                continue
            for margin_integer in range(4, 25, 2):
                margin = margin_integer / 100
                rules = template.decisions.model_copy(
                    update={
                        "autoMatchThreshold": auto,
                        "reviewThreshold": review,
                        "minimumTopCandidateMargin": margin,
                    }
                )
                metrics, _ = _quality_metrics(scored, truth_pairs, all_a_row_ids, rules)
                precision = metrics["autoMatchPrecision"]
                qualifies = (
                    metrics["autoMatchCount"] > 0
                    and precision is not None
                    and precision >= MINIMUM_TUNING_AUTO_PRECISION
                )
                objective = (
                    int(qualifies),
                    -metrics["falseAutoMatches"],
                    -metrics["truthUncoveredARows"],
                    metrics["trueAutoMatches"],
                    precision or 0.0,
                    -metrics["reviewRoutedARows"],
                    auto,
                    margin,
                    -review,
                )
                candidates.append((objective, rules, metrics))
    _, selected_rules, metrics = max(candidates, key=lambda item: item[0])
    frozen = template.model_copy(
        update={
            "frozen": True,
            "decisions": selected_rules,
        }
    )
    return frozen, {
        "minimumRequiredAutoMatchPrecision": MINIMUM_TUNING_AUTO_PRECISION,
        "searchCandidates": len(candidates),
        "selectedRules": selected_rules.model_dump(mode="json"),
        "selectedMetrics": metrics,
    }


def evaluate_matcher(
    generation: CandidateGenerationResult,
    scored: list[ScoredPair],
    baseline_scored: list[ScoredPair],
    truth_pairs: set[tuple[str, str]],
    truth_payload: dict[str, Any],
    hard_negative_payload: dict[str, Any],
    all_a_row_ids: set[str],
    config: MatcherConfig,
    fixture: dict[str, Any],
    *,
    phase: Literal["tuning", "holdout"],
) -> dict[str, Any]:
    if phase == "holdout":
        if not config.frozen or not config.tunedOnFixture:
            raise ValueError("Holdout evaluation requires a frozen tuning config")
        if config.tunedOnFixture == fixture.get("fixture_name"):
            raise ValueError("Holdout fixture cannot be the tuning fixture")
    metrics, classified = _quality_metrics(
        scored, truth_pairs, all_a_row_ids, config.decisions
    )
    baseline_rules = DecisionRules(
        autoMatchThreshold=0.82,
        reviewThreshold=0.38,
        minimumTopCandidateMargin=0.08,
        minimumAutoAgreementFields=1,
        alternativeFloor=0.30,
        alternativeWindow=0.25,
        maxAlternatives=3,
    )
    baseline_metrics, baseline_classified = _quality_metrics(
        baseline_scored,
        truth_pairs,
        all_a_row_ids,
        baseline_rules,
        enforce_contradictions=False,
        enforce_agreement_count=False,
    )
    hard_pairs = _hard_negative_pairs(truth_payload, hard_negative_payload)
    scored_by_pair = {(item.aRowId, item.bRowId): item for item in scored}
    hard_results = []
    for pair, pattern in sorted(hard_pairs.items()):
        item = scored_by_pair.get(pair)
        if not item:
            continue
        rank = next(
            index
            for index, ranked_item in enumerate(_rank(scored)[pair[0]], start=1)
            if ranked_item.bRowId == pair[1]
        )
        decision = classified[pair[0]]
        hard_results.append(
            {
                "aRowId": pair[0],
                "bRowId": pair[1],
                "pattern": pattern,
                "matchScore": item.matchScore,
                "rank": rank,
                "isTopCandidate": decision["top"].bRowId == pair[1],
                "autoMatched": decision["band"] == "auto_match"
                and decision["top"].bRowId == pair[1],
            }
        )
    hard_auto = sum(item["autoMatched"] for item in hard_results)
    baseline_hard_auto = sum(
        decision["band"] == "auto_match"
        and (decision["top"].aRowId, decision["top"].bRowId) in hard_pairs
        for decision in baseline_classified.values()
    )
    ranking_misses = []
    ranked = _rank(scored)
    for a_row_id, items in sorted(ranked.items()):
        true_items = [
            item for item in items if (item.aRowId, item.bRowId) in truth_pairs
        ]
        if not true_items or (items[0].aRowId, items[0].bRowId) in truth_pairs:
            continue
        best_true = true_items[0]
        ranking_misses.append(
            {
                "aRowId": a_row_id,
                "falseTopBRowId": items[0].bRowId,
                "falseTopScore": items[0].matchScore,
                "falseTopEvidence": [
                    {
                        "mappingId": evidence.mappingId,
                        "class": evidence.evidenceClass,
                        "contribution": evidence.contribution,
                    }
                    for evidence in items[0].evidence
                ],
                "bestTrueBRowId": best_true.bRowId,
                "bestTrueScore": best_true.matchScore,
                "bestTrueEvidence": [
                    {
                        "mappingId": evidence.mappingId,
                        "class": evidence.evidenceClass,
                        "contribution": evidence.contribution,
                    }
                    for evidence in best_true.evidence
                ],
            }
        )
    retention_losses = _post_score_retention_losses(
        scored, truth_pairs, classified, config.decisions
    )
    if len(retention_losses) != metrics["postScoreRetentionMisses"]:
        raise AssertionError("Post-score retention loss details do not reconcile")
    return {
        "evaluationVersion": MATCHER_EVALUATION_VERSION,
        "phase": phase,
        "fixture": fixture,
        "candidateEngineVersion": generation.engineVersion,
        "candidateConfig": generation.config.model_dump(mode="json"),
        "featurePipelineVersion": config.featurePipelineVersion,
        "matcherVersion": config.matcherVersion,
        "matcherConfig": config.model_dump(mode="json"),
        "metrics": {
            **metrics,
            "hardNegativeCandidatePairs": len(hard_results),
            "hardNegativeAutoMatches": hard_auto,
        },
        "decomposition": {
            "pairLevel": {
                "totalTrueCrossSourceLinks": metrics["truePairsTotal"],
                "candidateRetainedTrueLinks": metrics["candidateTruePairs"],
                "candidateMissedTrueLinks": metrics["candidateMisses"],
                "featureScoredTrueLinks": metrics["scoredTruePairs"],
                "trueLinksAtOrAboveReviewThreshold": metrics[
                    "truePairsAtOrAboveReviewThreshold"
                ],
                "trueLinksBelowReviewThreshold": metrics[
                    "belowReviewThresholdTruePairs"
                ],
                "postScoreRetentionMisses": metrics["postScoreRetentionMisses"],
                "endToEndRecoverableTrueLinks": metrics["retainedTruePairs"],
            },
            "aRowLevel": {
                "matchableARows": metrics["matchableARows"],
                "autoMatchedARows": metrics["autoMatchedARows"],
                "reviewRoutedARows": metrics["reviewRoutedARows"],
                "unmatchedMatchableARows": metrics["unmatchedMatchableARows"],
                "recoverableMatchableARows": metrics["recoverableMatchableARows"],
                "truthUncoveredARows": metrics["truthUncoveredARows"],
                "truthUncoveredAutoRows": metrics["truthUncoveredAutoRows"],
                "truthUncoveredReviewRows": metrics["truthUncoveredReviewRows"],
                "truthUncoveredUnmatchedRows": metrics["truthUncoveredUnmatchedRows"],
            },
        },
        "postScoreRetentionLosses": retention_losses,
        "scoreBands": _score_bands(scored, truth_pairs),
        "hardNegatives": hard_results,
        "rankingMisses": ranking_misses,
        "baselineComparison": {
            "matcherVersion": "baseline-matcher-v0.1.0",
            "metrics": baseline_metrics,
            "hardNegativeAutoMatches": baseline_hard_auto,
            "delta": {
                "falseAutoMatches": metrics["falseAutoMatches"]
                - baseline_metrics["falseAutoMatches"],
                "autoMatchPrecision": (
                    None
                    if metrics["autoMatchPrecision"] is None
                    or baseline_metrics["autoMatchPrecision"] is None
                    else round(
                        metrics["autoMatchPrecision"]
                        - baseline_metrics["autoMatchPrecision"],
                        9,
                    )
                ),
                "reviewRate": (
                    None
                    if metrics["reviewRate"] is None
                    or baseline_metrics["reviewRate"] is None
                    else round(
                        metrics["reviewRate"] - baseline_metrics["reviewRate"],
                        9,
                    )
                ),
                "top1TrueCandidateRate": (
                    None
                    if metrics["top1TrueCandidateRate"] is None
                    or baseline_metrics["top1TrueCandidateRate"] is None
                    else round(
                        metrics["top1TrueCandidateRate"]
                        - baseline_metrics["top1TrueCandidateRate"],
                        9,
                    )
                ),
            },
        },
    }


def run_fixture_evaluation(
    root: Path,
    fixture_name: str,
    mappings: list[ManualMapping],
    candidate_config: CandidateEngineConfig,
    matcher_config: MatcherConfig,
    *,
    phase: Literal["tuning", "holdout"],
) -> tuple[dict[str, Any], MatcherConfig | None]:
    """Generate visible candidates/scores first, then load evaluation-only truth."""

    from samewise_matcher.baseline import read_csv

    manifest_path = root / "evaluation" / "benchmarks" / fixture_name / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    def artifact(name: str) -> Path:
        return root / manifest["artifacts"][name]["path"]

    a_headers, a_rows = read_csv(artifact("dataset_a"))
    b_headers, b_rows = read_csv(artifact("dataset_b"))
    generation = generate_candidates(
        a_headers,
        a_rows,
        b_headers,
        b_rows,
        mappings,
        candidate_config,
    )
    scored = score_generated_candidates(
        generation,
        a_headers,
        a_rows,
        b_headers,
        b_rows,
        mappings,
        matcher_config,
    )
    baseline = _baseline_scored(
        generation, a_headers, a_rows, b_headers, b_rows, mappings
    )

    # Hidden artifacts are intentionally opened only after visible generation/scoring.
    truth_pairs = load_truth_pairs(artifact("identity_truth"))
    truth_payload = json.loads(artifact("identity_truth").read_text(encoding="utf-8"))
    hard_negatives = json.loads(artifact("hard_negatives").read_text(encoding="utf-8"))
    all_a = set(_rows_by_id(a_headers, a_rows, "A"))
    frozen: MatcherConfig | None = None
    tuning: dict[str, Any] | None = None
    if phase == "tuning":
        frozen, tuning = select_thresholds(scored, truth_pairs, all_a, matcher_config)
        frozen = frozen.model_copy(update={"tunedOnFixture": fixture_name})
        # Thresholds do not alter features, so reuse the visible scores.
        matcher_config = frozen
    report = evaluate_matcher(
        generation,
        scored,
        baseline,
        truth_pairs,
        truth_payload,
        hard_negatives,
        all_a,
        matcher_config,
        manifest,
        phase=phase,
    )
    if tuning is not None:
        report["thresholdSelection"] = tuning
    return report, frozen


def markdown_matcher_report(report: dict[str, Any]) -> str:
    metrics = report["metrics"]
    baseline = report["baselineComparison"]["metrics"]
    metrics_heading = (
        "Tuning evidence metrics"
        if report["phase"] == "tuning"
        else "Held-out evidence metrics"
    )

    def percent(value: float | None) -> str:
        return "n/a" if value is None else f"{value * 100:.6f}%"

    return "\n".join(
        [
            f"# SW-006 {report['phase']} matcher report",
            "",
            "Match scores are bounded evidence scores, not probabilities.",
            "",
            "## Reproducibility",
            "",
            f"- Fixture: `{report['fixture']['fixture_name']}`",
            f"- Seed: `{report['fixture']['seed']}`",
            f"- Candidate engine: `{report['candidateEngineVersion']}`",
            f"- Feature pipeline: `{report['featurePipelineVersion']}`",
            f"- Matcher: `{report['matcherVersion']}`",
            "",
            f"## {metrics_heading}",
            "",
            f"- Candidate recall: {percent(metrics['candidateRecall'])}",
            f"- Candidate misses: {metrics['candidateMisses']:,}",
            f"- Auto-match precision: {percent(metrics['autoMatchPrecision'])}",
            f"- Auto-match recall: {percent(metrics['autoMatchRecall'])}",
            f"- Review rate: {percent(metrics['reviewRate'])}",
            f"- False auto-matches: {metrics['falseAutoMatches']:,}",
            f"- Truth-uncovered A rows: {metrics['truthUncoveredARows']:,}",
            "- Candidate-conditional feature-scoring coverage: "
            f"{percent(metrics['candidateConditionalFeatureScoringCoverage'])}",
            "- Candidate-conditional review-threshold coverage: "
            f"{percent(metrics['candidateConditionalReviewThresholdCoverage'])}",
            "- Candidate-conditional retained-link coverage: "
            f"{percent(metrics['candidateConditionalRetentionRate'])}",
            f"- Top-1 true-candidate rate: {percent(metrics['top1TrueCandidateRate'])}",
            f"- Hard-negative auto-matches: {metrics['hardNegativeAutoMatches']:,}",
            "",
            "## Baseline comparison",
            "",
            f"- Baseline false auto-matches: {baseline['falseAutoMatches']:,}",
            "- Baseline auto-match precision: "
            f"{percent(baseline['autoMatchPrecision'])}",
            f"- Baseline review rate: {percent(baseline['reviewRate'])}",
            "- Baseline top-1 true-candidate rate: "
            f"{percent(baseline['top1TrueCandidateRate'])}",
            "",
        ]
    )
