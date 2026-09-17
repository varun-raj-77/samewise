"""Reproducible, stage-level performance evidence for the product matcher."""

from __future__ import annotations

import hashlib
import json
import platform
import sys
import time
import tracemalloc
from pathlib import Path
from typing import Any

from samewise_matcher.baseline import profile_rows, read_csv
from samewise_matcher.candidate_engine import (
    CandidateEngineConfig,
    generate_candidates,
)
from samewise_matcher.candidate_evaluation import load_truth_pairs
from samewise_matcher.explainable_matcher import (
    MatcherConfig,
    build_match_result,
    score_generated_candidates,
)
from samewise_matcher.workflow_models import ManualMapping

PERFORMANCE_BENCHMARK_VERSION = "performance-benchmark-v0.1.0"
PERFORMANCE_IMPLEMENTATION_REVISION = "sw-011-normalization-cache-v1"


def _artifact(root: Path, manifest: dict[str, Any], name: str) -> Path:
    return root / manifest["artifacts"][name]["path"]


def _round_seconds(value: float) -> float:
    return round(value, 6)


def benchmark_fixture(
    root: Path,
    fixture_name: str,
    mappings: list[ManualMapping],
    candidate_config: CandidateEngineConfig,
    matcher_config: MatcherConfig,
    *,
    trace_python_memory: bool = True,
) -> dict[str, Any]:
    """Benchmark one deterministic fixture without opening truth before scoring."""

    root = root.resolve()
    manifest_path = root / "evaluation" / "benchmarks" / fixture_name / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    a_path = _artifact(root, manifest, "dataset_a")
    b_path = _artifact(root, manifest, "dataset_b")
    timings: dict[str, float] = {}
    benchmark_started = time.perf_counter()
    if trace_python_memory:
        tracemalloc.start()

    input_started = time.perf_counter()
    a_headers, a_rows = read_csv(a_path)
    b_headers, b_rows = read_csv(b_path)
    timings["fixture_input_load_seconds"] = _round_seconds(
        time.perf_counter() - input_started
    )

    profile_started = time.perf_counter()
    profile_rows(a_headers, a_rows, "benchmark-A", "A", a_path.name, "0" * 64)
    profile_rows(b_headers, b_rows, "benchmark-B", "B", b_path.name, "0" * 64)
    timings["profiling_seconds"] = _round_seconds(
        time.perf_counter() - profile_started
    )

    matcher_started = time.perf_counter()
    generation = generate_candidates(
        a_headers,
        a_rows,
        b_headers,
        b_rows,
        mappings,
        candidate_config,
        performance_timings=timings,
    )
    a_by_id = {
        row.get(a_headers[0], "").strip() or f"A-{index + 1}": row
        for index, row in enumerate(a_rows)
    }
    b_by_id = {
        row.get(b_headers[0], "").strip() or f"B-{index + 1}": row
        for index, row in enumerate(b_rows)
    }
    identity = [mapping for mapping in mappings if mapping.role == "identity"]
    scored = score_generated_candidates(
        generation.candidates,
        a_by_id,
        b_by_id,
        identity,
        matcher_config,
        performance_timings=timings,
    )
    assembly_started = time.perf_counter()
    result = build_match_result(
        a_headers, a_rows, b_headers, b_rows, scored, matcher_config
    )
    timings["result_assembly_seconds"] = _round_seconds(
        time.perf_counter() - assembly_started
    )
    timings["matcher_without_serialization_seconds"] = _round_seconds(
        time.perf_counter() - matcher_started
    )

    serialization_started = time.perf_counter()
    serialized = result.model_dump_json()
    serialized_bytes = serialized.encode("utf-8")
    timings["api_serialization_seconds"] = _round_seconds(
        time.perf_counter() - serialization_started
    )
    timings["matcher_with_serialization_seconds"] = _round_seconds(
        time.perf_counter() - matcher_started
    )

    # Evaluation-only truth is deliberately opened after visible generation/scoring.
    evaluation_started = time.perf_counter()
    truth_pairs = load_truth_pairs(_artifact(root, manifest, "identity_truth"))
    candidate_pairs = {
        (candidate.aRowId, candidate.bRowId) for candidate in generation.candidates
    }
    retained_pairs = len(truth_pairs & candidate_pairs)
    timings["quality_evaluation_seconds"] = _round_seconds(
        time.perf_counter() - evaluation_started
    )

    current_memory = peak_memory = None
    if trace_python_memory:
        current_memory, peak_memory = tracemalloc.get_traced_memory()
        tracemalloc.stop()
    timings["benchmark_total_seconds"] = _round_seconds(
        time.perf_counter() - benchmark_started
    )

    theoretical_pairs = len(a_rows) * len(b_rows)
    candidate_count = len(generation.candidates)
    diagnostics = [
        item.model_dump(mode="json") for item in generation.blockerDiagnostics
    ]
    return {
        "benchmarkVersion": PERFORMANCE_BENCHMARK_VERSION,
        "implementationRevision": PERFORMANCE_IMPLEMENTATION_REVISION,
        "fixture": {
            "name": fixture_name,
            "seed": manifest["seed"],
            "generatorVersion": manifest["generator_version"],
            "config": manifest["requested_config"],
            "sourceArtifacts": {
                "A": manifest["artifacts"]["dataset_a"],
                "B": manifest["artifacts"]["dataset_b"],
            },
        },
        "versions": {
            "candidateEngine": generation.engineVersion,
            "blockingNormalization": generation.normalizationVersion,
            "featurePipeline": result.featurePipelineVersion,
            "matcher": result.matcherVersion,
            "matcherConfig": result.matcherConfigVersion,
        },
        "environment": {
            "python": sys.version.split()[0],
            "implementation": platform.python_implementation(),
            "platform": platform.platform(),
            "processor": platform.processor() or None,
        },
        "counts": {
            "sourceARows": len(a_rows),
            "sourceBRows": len(b_rows),
            "theoreticalPairs": theoretical_pairs,
            "emittedCandidates": candidate_count,
            "candidateReductionRatio": round(
                theoretical_pairs / candidate_count, 6
            )
            if candidate_count
            else None,
            "truePairs": len(truth_pairs),
            "retainedTruePairs": retained_pairs,
            "missedTruePairs": len(truth_pairs) - retained_pairs,
            "candidateRecall": round(retained_pairs / len(truth_pairs), 9)
            if truth_pairs
            else None,
            "productCandidates": len(result.candidates),
            "onlyA": len(result.onlyA),
            "onlyB": len(result.onlyB),
            "serializedResultBytes": len(serialized_bytes),
            "serializedResultSha256": hashlib.sha256(serialized_bytes).hexdigest(),
        },
        "timingsSeconds": timings,
        "memory": {
            "method": "python_tracemalloc" if trace_python_memory else "not_measured",
            "scope": (
                "peak traced Python allocations from pre-load through serialization "
                "and truth evaluation; excludes native/runtime/process RSS"
                if trace_python_memory
                else "disabled for this run"
            ),
            "currentTracedBytes": current_memory,
            "peakTracedBytes": peak_memory,
        },
        "suppression": {
            "keysSuppressed": sum(item["keysSuppressed"] for item in diagnostics),
            "relationshipsSuppressed": sum(
                item["relationshipsSuppressed"] for item in diagnostics
            ),
            "byBlocker": diagnostics,
        },
    }


def markdown_summary(report: dict[str, Any]) -> str:
    counts = report["counts"]
    timings = report["timingsSeconds"]
    memory = report["memory"]
    recall = counts["candidateRecall"]
    recall_line = (
        f"- Candidate recall: {recall * 100:.6f}%"
        if recall is not None
        else "- Candidate recall: n/a"
    )
    matcher_seconds = timings["matcher_with_serialization_seconds"]
    peak_memory = memory["peakTracedBytes"]
    peak_memory_text = (
        f"{peak_memory} bytes" if peak_memory is not None else "not measured"
    )
    return "\n".join(
        [
            f"# Performance benchmark: {report['fixture']['name']}",
            "",
            "Measured values describe this fixture and environment only.",
            "",
            f"- Rows: {counts['sourceARows']:,} A × {counts['sourceBRows']:,} B",
            f"- Theoretical pairs: {counts['theoreticalPairs']:,}",
            f"- Emitted candidates: {counts['emittedCandidates']:,}",
            f"- Candidate reduction: {counts['candidateReductionRatio']:,.6f}x",
            recall_line,
            f"- Matcher plus serialization: {matcher_seconds:.6f}s",
            f"- Serialized result: {counts['serializedResultBytes']:,} bytes",
            f"- Peak traced Python allocations: {peak_memory_text}",
            "",
        ]
    )
