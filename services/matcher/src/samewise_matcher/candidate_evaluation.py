"""Hidden-truth evaluation for already-generated candidate sets."""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path
from typing import Any

from samewise_matcher.blocking_normalization import (
    normalize_address,
    normalize_domain,
    normalize_email,
    normalize_name,
    normalize_phone,
    normalize_postal,
    normalize_text,
)
from samewise_matcher.candidate_engine import (
    CandidateGenerationResult,
    _key_hash,
    _mapping_kind,
    record_blocking_keys,
)
from samewise_matcher.workflow_models import ManualMapping

EVALUATION_VERSION = "candidate-evaluation-v0.1.0"


def load_truth_pairs(path: Path) -> set[tuple[str, str]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    by_entity_a: dict[str, list[str]] = defaultdict(list)
    by_entity_b: dict[str, list[str]] = defaultdict(list)
    for item in payload["source_a"]:
        by_entity_a[item["canonical_entity_id"]].append(item["source_row_id"])
    for item in payload["source_b"]:
        by_entity_b[item["canonical_entity_id"]].append(item["source_row_id"])
    return {
        (a_row_id, b_row_id)
        for entity_id in set(by_entity_a) & set(by_entity_b)
        for a_row_id in by_entity_a[entity_id]
        for b_row_id in by_entity_b[entity_id]
    }


def load_provenance(path: Path | None) -> dict[tuple[str, str], list[str]]:
    if path is None:
        return {}
    output: dict[tuple[str, str], list[str]] = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            item = json.loads(line)
            output[(item["source"], item["source_row_id"])] = sorted(
                {event["strategy"] for event in item.get("corruptions", [])}
            )
    return output


def _rows_by_id(
    headers: list[str], rows: list[dict[str, str]], side: str
) -> dict[str, dict[str, str]]:
    return {
        row.get(headers[0], "").strip() or f"{side}-{index + 1}": row
        for index, row in enumerate(rows)
    }


def _normalization_snapshot(
    row: dict[str, str], side: str, mappings: list[ManualMapping]
) -> dict[str, dict[str, str]]:
    output: dict[str, dict[str, str]] = {}
    normalizers = {
        "phone": normalize_phone,
        "email": normalize_email,
        "domain": normalize_domain,
        "name": normalize_name,
        "postal": normalize_postal,
        "city": normalize_text,
        "region": normalize_text,
        "address": normalize_address,
        "other": normalize_text,
    }
    for mapping in mappings:
        if mapping.role != "identity":
            continue
        column = mapping.aColumn if side == "A" else mapping.bColumn
        raw = row.get(column, "")
        output[mapping.mappingId] = {
            "column": column,
            "raw": raw,
            "normalized": normalizers[_mapping_kind(mapping)](raw),
        }
    return output


def _miss_diagnostic(
    pair: tuple[str, str],
    a_row: dict[str, str],
    b_row: dict[str, str],
    mappings: list[ManualMapping],
    result: CandidateGenerationResult,
    provenance: dict[tuple[str, str], list[str]],
) -> dict[str, Any]:
    a_keys = record_blocking_keys(a_row, "A", mappings, result.config)
    b_keys = record_blocking_keys(b_row, "B", mappings, result.config)
    suppressed = {
        diagnostic.blockerId: set(diagnostic.suppressedKeyHashes)
        for diagnostic in result.blockerDiagnostics
    }
    attempted = []
    for blocker in result.config.enabledBlockers:
        shared_hashes = sorted(
            _key_hash(key) for key in a_keys[blocker] & b_keys[blocker]
        )
        suppressed_shared = sorted(set(shared_hashes) & suppressed[blocker])
        if suppressed_shared:
            reason = "shared blocking key was suppressed by bucket policy"
        elif shared_hashes:
            reason = "shared key existed but candidate was not emitted"
        elif not a_keys[blocker] or not b_keys[blocker]:
            reason = "one or both records emitted no key for this blocker"
        else:
            reason = "records emitted keys but none intersected"
        attempted.append(
            {
                "blockerId": blocker,
                "aKeyCount": len(a_keys[blocker]),
                "bKeyCount": len(b_keys[blocker]),
                "sharedKeyHashes": shared_hashes,
                "suppressedSharedKeyHashes": suppressed_shared,
                "reason": reason,
            }
        )
    return {
        "aRowId": pair[0],
        "bRowId": pair[1],
        "visibleMappedValues": {
            "A": _normalization_snapshot(a_row, "A", mappings),
            "B": _normalization_snapshot(b_row, "B", mappings),
        },
        "attemptedBlockers": attempted,
        "evaluationOnlyCorruptions": {
            "A": provenance.get(("A", pair[0]), []),
            "B": provenance.get(("B", pair[1]), []),
        },
    }


def evaluate_candidates(
    result: CandidateGenerationResult,
    truth_pairs: set[tuple[str, str]],
    a_headers: list[str],
    a_rows: list[dict[str, str]],
    b_headers: list[str],
    b_rows: list[dict[str, str]],
    mappings: list[ManualMapping],
    *,
    provenance: dict[tuple[str, str], list[str]] | None = None,
    fixture: dict[str, Any] | None = None,
    generation_runtime_seconds: float | None = None,
    peak_python_memory_bytes: int | None = None,
) -> dict[str, Any]:
    """Evaluate with truth only after generation has completed."""

    candidate_pairs = {
        (candidate.aRowId, candidate.bRowId) for candidate in result.candidates
    }
    known_a = _rows_by_id(a_headers, a_rows, "A")
    known_b = _rows_by_id(b_headers, b_rows, "B")
    if any(a not in known_a or b not in known_b for a, b in candidate_pairs):
        raise ValueError("Candidate result references a nonexistent source row")
    retained = truth_pairs & candidate_pairs
    missed = sorted(truth_pairs - candidate_pairs)
    theoretical = len(a_rows) * len(b_rows)
    candidate_count = len(candidate_pairs)
    strategy_counts: Counter[str] = Counter()
    unique_counts: Counter[str] = Counter()
    overlap_counts: Counter[str] = Counter()
    for candidate in result.candidates:
        blockers = sorted({item.blockerId for item in candidate.blockingEvidence})
        strategy_counts.update(blockers)
        if len(blockers) == 1:
            unique_counts.update(blockers)
        for left, right in combinations(blockers, 2):
            overlap_counts[f"{left}+{right}"] += 1
    report: dict[str, Any] = {
        "evaluationVersion": EVALUATION_VERSION,
        "fixture": fixture or {},
        "candidateEngineVersion": result.engineVersion,
        "candidateConfig": result.config.model_dump(mode="json"),
        "metrics": {
            "aRows": len(a_rows),
            "bRows": len(b_rows),
            "theoreticalPairs": theoretical,
            "candidatePairs": candidate_count,
            "reductionRatio": (
                round(theoretical / candidate_count, 6) if candidate_count else None
            ),
            "truePairsTotal": len(truth_pairs),
            "truePairsRetained": len(retained),
            "truePairsMissed": len(missed),
            "candidateRecall": (
                round(len(retained) / len(truth_pairs), 9) if truth_pairs else None
            ),
            "candidatesByStrategy": dict(sorted(strategy_counts.items())),
            "uniqueCandidatesByStrategy": dict(sorted(unique_counts.items())),
            "pairwiseStrategyOverlaps": dict(sorted(overlap_counts.items())),
            "zeroCandidateARecords": len(result.zeroCandidateARowIds),
            "zeroCandidateBRecords": len(result.zeroCandidateBRowIds),
            "generationRuntimeSeconds": generation_runtime_seconds,
            "peakPythonMemoryBytes": peak_python_memory_bytes,
        },
        "bucketDiagnostics": [
            item.model_dump(mode="json") for item in result.blockerDiagnostics
        ],
        "missedTrueMatches": [
            _miss_diagnostic(
                pair,
                known_a[pair[0]],
                known_b[pair[1]],
                mappings,
                result,
                provenance or {},
            )
            for pair in missed
        ],
    }
    return report


def markdown_summary(report: dict[str, Any]) -> str:
    metrics = report["metrics"]
    recall = metrics["candidateRecall"]
    recall_text = "n/a" if recall is None else f"{recall * 100:.6f}%"
    reduction = metrics["reductionRatio"]
    reduction_text = (
        "infinite (zero candidates)" if reduction is None else f"{reduction:,.3f}x"
    )
    peak_memory = metrics["peakPythonMemoryBytes"]
    peak_memory_text = (
        "not measured" if peak_memory is None else f"{peak_memory} bytes"
    )
    lines = [
        "# Candidate benchmark report",
        "",
        "This evaluates candidate retention only. It is not final matching recall,",
        "precision, accuracy, or an auto-match quality claim.",
        "",
        "## Reproducibility",
        "",
        f"- Candidate engine: `{report['candidateEngineVersion']}`",
        f"- Evaluation: `{report['evaluationVersion']}`",
        f"- Fixture: `{report['fixture'].get('fixture_name', 'unspecified')}`",
        f"- Generator: `{report['fixture'].get('generator_version', 'unspecified')}`",
        f"- Seed: `{report['fixture'].get('seed', 'unspecified')}`",
        "",
        "## Metrics",
        "",
        f"- A rows: {metrics['aRows']:,}",
        f"- B rows: {metrics['bRows']:,}",
        f"- Theoretical pairs: {metrics['theoreticalPairs']:,}",
        f"- Candidate pairs: {metrics['candidatePairs']:,}",
        f"- Reduction ratio: {reduction_text}",
        f"- True pairs total: {metrics['truePairsTotal']:,}",
        f"- True pairs retained: {metrics['truePairsRetained']:,}",
        f"- True pairs missed: {metrics['truePairsMissed']:,}",
        f"- Candidate recall: {recall_text}",
        f"- Generation runtime: {metrics['generationRuntimeSeconds']} seconds",
        f"- Peak traced Python memory: {peak_memory_text}",
        "",
        "## Misses",
        "",
        (
            "No true cross-source pair was missed."
            if not report["missedTrueMatches"]
            else (
                f"{len(report['missedTrueMatches'])} miss diagnostics are present "
                "in `misses.json`."
            )
        ),
        "",
    ]
    return "\n".join(lines)
