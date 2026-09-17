import json
from pathlib import Path

from samewise_matcher.candidate_engine import CandidateEngineConfig
from samewise_matcher.explainable_matcher import MatcherConfig
from samewise_matcher.performance_benchmark import benchmark_fixture
from samewise_matcher.workflow_models import ManualMapping

ROOT = Path(__file__).resolve().parents[3]


def test_stage_benchmark_is_machine_readable_and_truth_is_reported() -> None:
    mappings_payload = json.loads(
        (
            ROOT / "evaluation/configs/organizations-confirmed-mappings-v1.json"
        ).read_text(encoding="utf-8")
    )
    mappings = [
        ManualMapping.model_validate(item) for item in mappings_payload["mappings"]
    ]
    candidate_config = CandidateEngineConfig.model_validate_json(
        (ROOT / "evaluation/configs/candidate-engine-v0.3.0.json").read_text(
            encoding="utf-8"
        )
    )
    matcher_config = MatcherConfig.model_validate_json(
        (
            ROOT
            / "evaluation/configs/matcher-v0.2.0-candidate-v0.3.0.json"
        ).read_text(
            encoding="utf-8"
        )
    )
    report = benchmark_fixture(
        ROOT,
        "organizations-dev-v1",
        mappings,
        candidate_config,
        matcher_config,
        trace_python_memory=False,
    )
    assert report["counts"]["sourceARows"] == 23
    assert report["counts"]["sourceBRows"] == 22
    assert report["counts"]["candidateRecall"] == 1
    assert report["counts"]["emittedCandidates"] < 23 * 22
    assert report["memory"]["method"] == "not_measured"
    assert {
        "fixture_input_load_seconds",
        "profiling_seconds",
        "normalization_index_construction_seconds",
        "candidate_generation_seconds",
        "feature_normalization_cache_seconds",
        "feature_extraction_seconds",
        "scoring_seconds",
        "result_assembly_seconds",
        "api_serialization_seconds",
    } <= report["timingsSeconds"].keys()
