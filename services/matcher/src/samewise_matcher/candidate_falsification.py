"""Evaluation-only adversarial analysis for candidate-engine-v0.1.0."""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from samewise_matcher.candidate_engine import (
    BlockerId,
    CandidateEngineConfig,
    CandidateGenerationResult,
    _key_hash,
    generate_candidates,
    record_blocking_keys,
)
from samewise_matcher.candidate_evaluation import evaluate_candidates
from samewise_matcher.workflow_models import ManualMapping

FALSIFICATION_VERSION = "candidate-falsification-v0.1.0"


def _rows_by_id(
    headers: list[str], rows: list[dict[str, str]], side: str
) -> dict[str, dict[str, str]]:
    return {
        row.get(headers[0], "").strip() or f"{side}-{index + 1}": row
        for index, row in enumerate(rows)
    }


def stratify_exact_identifiers(
    truth_pairs: set[tuple[str, str]],
    a_headers: list[str],
    a_rows: list[dict[str, str]],
    b_headers: list[str],
    b_rows: list[dict[str, str]],
    mappings: list[ManualMapping],
    base_config: CandidateEngineConfig,
) -> tuple[set[tuple[str, str]], set[tuple[str, str]]]:
    """Classify truth pairs after generation using visible normalized values."""

    exact_config = base_config.model_copy(
        update={"enabledBlockers": ("exact_strong_v1",)}
    )
    a_by_id = _rows_by_id(a_headers, a_rows, "A")
    b_by_id = _rows_by_id(b_headers, b_rows, "B")
    a_keys = {
        row_id: record_blocking_keys(row, "A", mappings, exact_config)[
            "exact_strong_v1"
        ]
        for row_id, row in a_by_id.items()
    }
    b_keys = {
        row_id: record_blocking_keys(row, "B", mappings, exact_config)[
            "exact_strong_v1"
        ]
        for row_id, row in b_by_id.items()
    }
    strong = {pair for pair in truth_pairs if a_keys[pair[0]] & b_keys[pair[1]]}
    return strong, truth_pairs - strong


def _stratum_metrics(
    pairs: set[tuple[str, str]], candidates: set[tuple[str, str]]
) -> dict[str, int | float | None]:
    retained = pairs & candidates
    return {
        "truePairsTotal": len(pairs),
        "truePairsRetained": len(retained),
        "truePairsMissed": len(pairs - candidates),
        "candidateRecall": round(len(retained) / len(pairs), 9) if pairs else None,
    }


def analyze_suppression(
    result: CandidateGenerationResult,
    truth_pairs: set[tuple[str, str]],
    a_headers: list[str],
    a_rows: list[dict[str, str]],
    b_headers: list[str],
    b_rows: list[dict[str, str]],
    mappings: list[ManualMapping],
) -> dict[str, Any]:
    a_by_id = _rows_by_id(a_headers, a_rows, "A")
    b_by_id = _rows_by_id(b_headers, b_rows, "B")
    suppressed_hashes = {
        diagnostic.blockerId: set(diagnostic.suppressedKeyHashes)
        for diagnostic in result.blockerDiagnostics
    }
    candidate_map = {
        (candidate.aRowId, candidate.bRowId): {
            evidence.blockerId for evidence in candidate.blockingEvidence
        }
        for candidate in result.candidates
    }
    affected: set[tuple[str, str]] = set()
    rescued: set[tuple[str, str]] = set()
    rescued_other: set[tuple[str, str]] = set()
    missed: set[tuple[str, str]] = set()
    by_blocker: dict[str, Counter[str]] = defaultdict(Counter)

    for pair in sorted(truth_pairs):
        a_keys = record_blocking_keys(a_by_id[pair[0]], "A", mappings, result.config)
        b_keys = record_blocking_keys(b_by_id[pair[1]], "B", mappings, result.config)
        suppressed_blockers: set[str] = set()
        for blocker in result.config.enabledBlockers:
            shared_hashes = {
                _key_hash(key) for key in a_keys[blocker] & b_keys[blocker]
            }
            if shared_hashes & suppressed_hashes[blocker]:
                suppressed_blockers.add(blocker)
                by_blocker[blocker]["truePairsAffected"] += 1
        if not suppressed_blockers:
            continue
        affected.add(pair)
        if pair in candidate_map:
            rescued.add(pair)
            for blocker in suppressed_blockers:
                by_blocker[blocker]["retainedDespiteSuppression"] += 1
            if candidate_map[pair] - suppressed_blockers:
                rescued_other.add(pair)
        else:
            missed.add(pair)
            for blocker in suppressed_blockers:
                by_blocker[blocker]["missedAfterSuppression"] += 1

    diagnostics = {
        item.blockerId: {
            "keysSuppressed": item.keysSuppressed,
            "relationshipsSuppressed": item.relationshipsSuppressed,
        }
        for item in result.blockerDiagnostics
    }
    return {
        "keysSuppressed": sum(
            item.keysSuppressed for item in result.blockerDiagnostics
        ),
        "perKeyRelationshipsSuppressed": sum(
            item.relationshipsSuppressed for item in result.blockerDiagnostics
        ),
        "truePairsWithSuppressedUsefulKey": len(affected),
        "truePairsRetainedDespiteSuppression": len(rescued),
        "truePairsRescuedByDifferentBlocker": len(rescued_other),
        "truePairsMissedAfterSuppression": len(missed),
        "byBlocker": {
            blocker: dict(sorted(counts.items()))
            for blocker, counts in sorted(by_blocker.items())
        },
        "bucketTotalsByBlocker": diagnostics,
    }


def analyze_hard_negatives(
    result: CandidateGenerationResult,
    truth_payload: dict[str, Any],
    hard_negative_payload: dict[str, Any],
) -> dict[str, Any]:
    by_entity_a: dict[str, list[str]] = defaultdict(list)
    by_entity_b: dict[str, list[str]] = defaultdict(list)
    for item in truth_payload["source_a"]:
        by_entity_a[item["canonical_entity_id"]].append(item["source_row_id"])
    for item in truth_payload["source_b"]:
        by_entity_b[item["canonical_entity_id"]].append(item["source_row_id"])
    candidate_map = {
        (candidate.aRowId, candidate.bRowId): sorted(
            {evidence.blockerId for evidence in candidate.blockingEvidence}
        )
        for candidate in result.candidates
    }
    known_pairs: dict[tuple[str, str], str] = {}
    for pattern in hard_negative_payload["patterns"]:
        left = pattern["left_canonical_entity_id"]
        right = pattern["right_canonical_entity_id"]
        for a_id in by_entity_a[left]:
            for b_id in by_entity_b[right]:
                known_pairs[(a_id, b_id)] = pattern["pattern"]
        for a_id in by_entity_a[right]:
            for b_id in by_entity_b[left]:
                known_pairs[(a_id, b_id)] = pattern["pattern"]
    entered = [
        {
            "aRowId": pair[0],
            "bRowId": pair[1],
            "pattern": known_pairs[pair],
            "blockers": candidate_map[pair],
        }
        for pair in sorted(known_pairs)
        if pair in candidate_map
    ]
    blocker_counts: Counter[str] = Counter(
        blocker for item in entered for blocker in item["blockers"]
    )
    return {
        "knownCrossSourcePairs": len(known_pairs),
        "candidatePairsEntered": len(entered),
        "candidateCoverage": (
            round(len(entered) / len(known_pairs), 9) if known_pairs else None
        ),
        "blockerCounts": dict(sorted(blocker_counts.items())),
        "enteredPairs": entered,
    }


def _variant_configs(base: CandidateEngineConfig) -> dict[str, CandidateEngineConfig]:
    enabled = tuple(base.enabledBlockers)
    variants: dict[str, tuple[BlockerId, ...]] = {
        "full": enabled,
        "exact_only": ("exact_strong_v1",),
        "without_exact_strong_v1": tuple(
            blocker for blocker in enabled if blocker != "exact_strong_v1"
        ),
    }
    for blocker in enabled:
        if blocker == "exact_strong_v1":
            continue
        variants[f"without_{blocker}"] = tuple(
            item for item in enabled if item != blocker
        )
    return {
        name: base.model_copy(update={"enabledBlockers": blockers})
        for name, blockers in variants.items()
    }


def run_falsification(
    a_headers: list[str],
    a_rows: list[dict[str, str]],
    b_headers: list[str],
    b_rows: list[dict[str, str]],
    mappings: list[ManualMapping],
    base_config: CandidateEngineConfig,
    truth_payload: dict[str, Any],
    hard_negative_payload: dict[str, Any],
    fixture: dict[str, Any],
    provenance: dict[tuple[str, str], list[str]] | None = None,
) -> dict[str, Any]:
    """Generate every variant first, then evaluate with hidden truth."""

    variants = {
        name: generate_candidates(
            a_headers, a_rows, b_headers, b_rows, mappings, config
        )
        for name, config in _variant_configs(base_config).items()
    }
    by_entity_a: dict[str, list[str]] = defaultdict(list)
    by_entity_b: dict[str, list[str]] = defaultdict(list)
    for item in truth_payload["source_a"]:
        by_entity_a[item["canonical_entity_id"]].append(item["source_row_id"])
    for item in truth_payload["source_b"]:
        by_entity_b[item["canonical_entity_id"]].append(item["source_row_id"])
    truth_pairs = {
        (a_id, b_id)
        for entity in set(by_entity_a) & set(by_entity_b)
        for a_id in by_entity_a[entity]
        for b_id in by_entity_b[entity]
    }
    strong, weak = stratify_exact_identifiers(
        truth_pairs,
        a_headers,
        a_rows,
        b_headers,
        b_rows,
        mappings,
        base_config,
    )
    ablations = []
    variant_evaluations: dict[str, dict[str, Any]] = {}
    for name, result in variants.items():
        evaluation = evaluate_candidates(
            result,
            truth_pairs,
            a_headers,
            a_rows,
            b_headers,
            b_rows,
            mappings,
            provenance=provenance,
            fixture=fixture,
        )
        variant_evaluations[name] = evaluation
        candidates = {
            (candidate.aRowId, candidate.bRowId) for candidate in result.candidates
        }
        metrics = evaluation["metrics"]
        ablations.append(
            {
                "variant": name,
                "enabledBlockers": list(result.config.enabledBlockers),
                "candidatePairs": metrics["candidatePairs"],
                "reductionRatio": metrics["reductionRatio"],
                "truePairsRetained": metrics["truePairsRetained"],
                "truePairsTotal": metrics["truePairsTotal"],
                "truePairsMissed": metrics["truePairsMissed"],
                "candidateRecall": metrics["candidateRecall"],
                "strongIdentifier": _stratum_metrics(strong, candidates),
                "weakIdentifier": _stratum_metrics(weak, candidates),
                "uniqueCandidatesByStrategy": metrics["uniqueCandidatesByStrategy"],
            }
        )

    full = variants["full"]
    full_candidates = {
        (candidate.aRowId, candidate.bRowId): candidate for candidate in full.candidates
    }
    weak_blocker_counts: Counter[str] = Counter()
    for pair in weak & set(full_candidates):
        weak_blocker_counts.update(
            {item.blockerId for item in full_candidates[pair].blockingEvidence}
        )
    full_evaluation = variant_evaluations["full"]
    return {
        "falsificationVersion": FALSIFICATION_VERSION,
        "candidateEngineVersion": full.engineVersion,
        "fixture": fixture,
        "candidateConfig": base_config.model_dump(mode="json"),
        "ablations": ablations,
        "overall": full_evaluation["metrics"],
        "stratifiedRecall": {
            "strongIdentifier": _stratum_metrics(strong, set(full_candidates)),
            "weakIdentifier": _stratum_metrics(weak, set(full_candidates)),
        },
        "weakTruePairsRetainedByBlocker": dict(sorted(weak_blocker_counts.items())),
        "suppressionAnalysis": analyze_suppression(
            full,
            truth_pairs,
            a_headers,
            a_rows,
            b_headers,
            b_rows,
            mappings,
        ),
        "hardNegativeCoverage": analyze_hard_negatives(
            full, truth_payload, hard_negative_payload
        ),
        "missedTrueMatches": full_evaluation["missedTrueMatches"],
    }


def markdown_falsification_summary(report: dict[str, Any]) -> str:
    overall = report["overall"]
    strong = report["stratifiedRecall"]["strongIdentifier"]
    weak = report["stratifiedRecall"]["weakIdentifier"]
    lines = [
        "# Candidate-engine falsification",
        "",
        f"- Engine: `{report['candidateEngineVersion']}`",
        f"- Fixture: `{report['fixture']['fixture_name']}`",
        f"- Candidates: {overall['candidatePairs']:,}",
        f"- Reduction: {overall['reductionRatio']:,.6f}x",
        (
            f"- Overall retention: {overall['truePairsRetained']:,}/"
            f"{overall['truePairsTotal']:,}"
        ),
        (
            f"- Strong-identifier retention: {strong['truePairsRetained']:,}/"
            f"{strong['truePairsTotal']:,}"
        ),
        (
            f"- Weak-identifier retention: {weak['truePairsRetained']:,}/"
            f"{weak['truePairsTotal']:,}"
        ),
        f"- Misses: {overall['truePairsMissed']:,}",
        "",
        "Candidate recall is not final matching recall or precision.",
        "",
    ]
    return "\n".join(lines)
