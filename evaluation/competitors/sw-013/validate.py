"""Validate and execute the deterministic SW-013 competitor scenarios."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MATCHER_SRC = ROOT / "services" / "matcher" / "src"
if str(MATCHER_SRC) not in sys.path:
    sys.path.insert(0, str(MATCHER_SRC))

from samewise_matcher.baseline import read_csv  # noqa: E402
from samewise_matcher.explainable_matcher import (  # noqa: E402
    MatcherConfig,
    build_match_result,
    score_rows,
)
from samewise_matcher.workflow_models import ManualMapping  # noqa: E402

BASE = ROOT / "evaluation" / "competitors" / "sw-013"
FORBIDDEN_INPUT_COLUMNS = {
    "canonical_id",
    "entity_id",
    "expected_match",
    "is_match",
    "truth",
}


def _load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def _rows_by_id(path: Path) -> dict[str, dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return {row["record_id"]: row for row in csv.DictReader(handle)}


def _content_hash(payload: object) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _write_power_query_package(scenario_dirs: list[Path]) -> None:
    output_dir = BASE / "power-query"
    output_dir.mkdir(parents=True, exist_ok=True)
    columns = [
        "scenario_id",
        "record_id",
        "stable_id",
        "name",
        "address",
        "email",
        "phone",
        "city",
        "region",
        "postal",
        "contact_name",
        "updated_at",
    ]
    combined: dict[str, list[dict[str, str]]] = {"a": [], "b": []}
    truth_rows: list[dict[str, str]] = []
    manifest_rows: list[dict[str, str]] = []
    for scenario_dir in scenario_dirs:
        metadata = _load_json(scenario_dir / "scenario.json")
        truth = _load_json(scenario_dir / "truth" / "identity_truth.json")
        assert isinstance(metadata, dict) and isinstance(truth, dict)
        scenario_id = str(metadata["scenarioId"])
        for side in ("a", "b"):
            for row in _rows_by_id(scenario_dir / f"dataset_{side}.csv").values():
                combined[side].append({"scenario_id": scenario_id, **row})
        for pair in truth["pairs"]:
            truth_rows.append(
                {
                    "scenario_id": scenario_id,
                    "a_record_id": pair["aRowId"],
                    "b_record_id": pair["bRowId"],
                    "expected": "MATCH",
                }
            )
        for a_row_id in truth["aOnly"]:
            truth_rows.append(
                {"scenario_id": scenario_id, "a_record_id": a_row_id, "b_record_id": "", "expected": "A_ONLY"}
            )
        for b_row_id in truth["bOnly"]:
            truth_rows.append(
                {"scenario_id": scenario_id, "a_record_id": "", "b_record_id": b_row_id, "expected": "B_ONLY"}
            )
        manifest_rows.append(
            {"scenario_id": scenario_id, "scenario_name": str(metadata["scenarioName"])}
        )

    for side in ("a", "b"):
        with (output_dir / f"dataset_{side}.csv").open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\n")
            writer.writeheader()
            writer.writerows(combined[side])
    with (output_dir / "expected_truth.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["scenario_id", "a_record_id", "b_record_id", "expected"],
            lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(truth_rows)
    with (output_dir / "scenario-manifest.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle, fieldnames=["scenario_id", "scenario_name"], lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(manifest_rows)


def _execute_scenario(
    scenario_dir: Path, mappings: list[ManualMapping]
) -> tuple[dict[str, object], dict[str, object]]:
    metadata = _load_json(scenario_dir / "scenario.json")
    truth = _load_json(scenario_dir / "truth" / "identity_truth.json")
    assert isinstance(metadata, dict) and isinstance(truth, dict)
    a_path = scenario_dir / "dataset_a.csv"
    b_path = scenario_dir / "dataset_b.csv"
    a_headers, a_rows = read_csv(a_path)
    b_headers, b_rows = read_csv(b_path)

    leaked = (set(a_headers) | set(b_headers)) & FORBIDDEN_INPUT_COLUMNS
    if leaked:
        raise AssertionError(f"{metadata['scenarioId']} truth leaked in columns: {leaked}")
    if set(a_headers) != set(b_headers):
        raise AssertionError(f"{metadata['scenarioId']} input schemas differ")

    config = MatcherConfig()
    scored, generated_by_a = score_rows(
        a_headers,
        a_rows,
        b_headers,
        b_rows,
        mappings,
        config,
        candidate_mode="candidate_engine",
    )
    result = build_match_result(a_headers, a_rows, b_headers, b_rows, scored, config)
    serialized = result.model_dump(mode="json")
    generated_pairs = {
        (candidate.aRowId, candidate.bRowId)
        for candidates in generated_by_a.values()
        for candidate in candidates
    }
    truth_pairs = {
        (pair["aRowId"], pair["bRowId"])
        for pair in truth["pairs"]
    }
    top = {candidate.aRowId: candidate for candidate in result.candidates if candidate.rank == 1}
    auto = [candidate for candidate in top.values() if candidate.band == "auto_match"]
    review = [candidate for candidate in top.values() if candidate.band == "needs_review"]
    false_auto = [
        candidate
        for candidate in auto
        if (candidate.aRowId, candidate.bRowId) not in truth_pairs
    ]
    retained_truth = truth_pairs & generated_pairs
    a_by_id = _rows_by_id(a_path)
    b_by_id = _rows_by_id(b_path)
    declared_conflict_fields = metadata.get("survivorshipFields", [])
    comparison_columns = {mapping.aColumn for mapping in mappings if mapping.role == "comparison"}
    raw_conflicts: list[dict[str, str]] = []
    product_conflicts: list[dict[str, str]] = []
    for a_row_id, b_row_id in sorted(truth_pairs):
        for field in declared_conflict_fields:
            if a_by_id[a_row_id][field] != b_by_id[b_row_id][field]:
                item = {"aRowId": a_row_id, "bRowId": b_row_id, "field": field}
                raw_conflicts.append(item)
                if field in comparison_columns:
                    product_conflicts.append(item)

    review_evidence_counts = [len(candidate.evidence) for candidate in review]
    output = {
        "scenarioId": metadata["scenarioId"],
        "scenarioName": metadata["scenarioName"],
        "samewiseResult": {
            "autoMatched": len(auto),
            "needsReview": len(review),
            "falseAutoMatches": len(false_auto),
            "candidateMisses": len(truth_pairs - generated_pairs),
            "candidateRecall": (
                round(len(retained_truth) / len(truth_pairs), 6) if truth_pairs else None
            ),
            "decisionsRequired": len(review),
            "evidenceFieldsVisiblePerDecision": {
                "minimum": min(review_evidence_counts) if review_evidence_counts else 0,
                "maximum": max(review_evidence_counts) if review_evidence_counts else 0,
            },
            "unresolvedCollisions": sum(candidate.collision for candidate in top.values()),
            "rawConflictingFieldsAfterIdentity": raw_conflicts,
            "productComparisonFieldConflictsAfterIdentity": product_conflicts,
            "retainedAlternatives": len(result.candidates) - len(top),
            "onlyA": len(result.onlyA),
            "onlyB": len(result.onlyB),
        },
        "samewiseEvidence": {
            "mode": "EXECUTED",
            "matcherVersion": result.matcherVersion,
            "candidateEngineVersion": result.candidateEngineVersion,
            "matcherConfigVersion": result.matcherConfigVersion,
            "outputSha256": _content_hash(serialized),
        },
        "powerQueryExpectation": metadata["powerQueryExpectation"],
    }
    return output, serialized


def run_suite(*, write: bool) -> dict[str, object]:
    mappings_payload = _load_json(BASE / "mappings.json")
    assert isinstance(mappings_payload, dict)
    mappings = [ManualMapping.model_validate(item) for item in mappings_payload["mappings"]]
    comparisons = _load_json(BASE / "scenario-comparisons.json")
    assert isinstance(comparisons, dict)
    scenario_dirs = sorted(path.parent for path in (BASE / "scenarios").glob("*/scenario.json"))
    if len(scenario_dirs) != 10:
        raise AssertionError(f"Expected 10 scenarios, found {len(scenario_dirs)}")

    results: list[dict[str, object]] = []
    first_outputs: dict[str, dict[str, object]] = {}
    for scenario_dir in scenario_dirs:
        result, serialized = _execute_scenario(scenario_dir, mappings)
        results.append(result)
        first_outputs[result["scenarioId"]] = serialized

    for scenario_dir in scenario_dirs:
        result, serialized = _execute_scenario(scenario_dir, mappings)
        if first_outputs[result["scenarioId"]] != serialized:
            raise AssertionError(f"{result['scenarioId']} output is not deterministic")

    by_id = {item["scenarioId"]: item for item in results}
    for item in results:
        item["competitorComparison"] = comparisons[item["scenarioId"]]
    if by_id["S01"]["samewiseResult"]["candidateRecall"] != 1.0:
        raise AssertionError("S01 exact join must retain all true pairs")
    if by_id["S06"]["samewiseResult"]["unresolvedCollisions"] < 2:
        raise AssertionError("S06 must expose both sides of the collision")
    if by_id["S07"]["samewiseResult"]["rawConflictingFieldsAfterIdentity"] == []:
        raise AssertionError("S07 must contain post-identity field conflicts")
    if sum(item["samewiseResult"]["falseAutoMatches"] for item in results) != 0:
        raise AssertionError("The committed suite must not contain a false auto-match")

    artifact = {
        "artifactVersion": "sw-013-scenario-results-v1",
        "generatedBy": "evaluation/competitors/sw-013/validate.py",
        "comparisonScope": "Samewise executed; competitors documentary unless explicitly noted",
        "scenarios": sorted(results, key=lambda item: item["scenarioId"]),
    }
    if write:
        (BASE / "scenario-results.json").write_text(
            json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        _write_power_query_package(scenario_dirs)
    return artifact


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    artifact = run_suite(write=args.write)
    print(json.dumps(artifact, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
