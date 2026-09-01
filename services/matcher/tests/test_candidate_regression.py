import inspect
import json
from pathlib import Path

import samewise_matcher.candidate_engine as product_candidate_module
from samewise_matcher.baseline import read_csv
from samewise_matcher.candidate_engine import (
    CandidateEngineConfig,
    generate_candidates,
)
from samewise_matcher.candidate_evaluation import (
    evaluate_candidates,
    load_truth_pairs,
)
from samewise_matcher.candidate_falsification import run_falsification
from samewise_matcher.weak_identifier_fixture import (
    WeakIdentifierFixtureConfig,
    generate_weak_identifier_fixture,
)
from samewise_matcher.workflow_models import ManualMapping

ROOT = Path(__file__).parents[3]


def test_product_candidate_module_has_no_hidden_truth_dependency() -> None:
    source = inspect.getsource(product_candidate_module).casefold()
    for forbidden in (
        "identity_truth",
        "canonical_entity",
        "corruption_provenance",
        "hard_negative",
        "ground-truth",
    ):
        assert forbidden not in source


def test_development_fixture_candidate_snapshot() -> None:
    fixture = "organizations-dev-v1"
    fixture_root = ROOT / "fixtures" / "corrupted" / "organizations" / fixture
    truth_path = (
        ROOT
        / "fixtures"
        / "ground-truth"
        / "organizations"
        / fixture
        / "identity_truth.json"
    )
    mapping_payload = json.loads(
        (
            ROOT / "evaluation/configs/organizations-confirmed-mappings-v1.json"
        ).read_text(encoding="utf-8")
    )
    mappings = [
        ManualMapping.model_validate(item) for item in mapping_payload["mappings"]
    ]
    config = CandidateEngineConfig.model_validate_json(
        (ROOT / "evaluation/configs/candidate-engine-v0.1.0.json").read_text(
            encoding="utf-8"
        )
    )
    a_headers, a_rows = read_csv(fixture_root / "dataset_a.csv")
    b_headers, b_rows = read_csv(fixture_root / "dataset_b.csv")
    generated = generate_candidates(
        a_headers, a_rows, b_headers, b_rows, mappings, config
    )
    report = evaluate_candidates(
        generated,
        load_truth_pairs(truth_path),
        a_headers,
        a_rows,
        b_headers,
        b_rows,
        mappings,
    )
    metrics = report["metrics"]
    snapshot = json.loads(
        (
            ROOT
            / "evaluation"
            / "benchmarks"
            / fixture
            / "candidate-snapshot-v0.1.0.json"
        ).read_text(encoding="utf-8")
    )
    for key in (
        "theoreticalPairs",
        "candidatePairs",
        "truePairsTotal",
        "truePairsRetained",
        "truePairsMissed",
        "candidateRecall",
        "candidatesByStrategy",
        "uniqueCandidatesByStrategy",
        "zeroCandidateARecords",
        "zeroCandidateBRecords",
    ):
        assert metrics[key] == snapshot[key]


def test_weak_identifier_falsification_snapshot(tmp_path: Path) -> None:
    fixture_config = WeakIdentifierFixtureConfig.model_validate_json(
        (
            ROOT
            / "evaluation"
            / "benchmark-configs"
            / "organizations-weak-identifiers-1500-v1.json"
        ).read_text(encoding="utf-8")
    )
    generated_root = tmp_path / "weak-fixture"
    manifest = generate_weak_identifier_fixture(fixture_config, generated_root)
    artifacts = manifest["artifacts"]
    a_headers, a_rows = read_csv(generated_root / artifacts["dataset_a"]["path"])
    b_headers, b_rows = read_csv(generated_root / artifacts["dataset_b"]["path"])
    mapping_payload = json.loads(
        (
            ROOT / "evaluation/configs/organizations-confirmed-mappings-v1.json"
        ).read_text(encoding="utf-8")
    )
    mappings = [
        ManualMapping.model_validate(item) for item in mapping_payload["mappings"]
    ]
    candidate_config = CandidateEngineConfig.model_validate_json(
        (ROOT / "evaluation/configs/candidate-engine-v0.2.0.json").read_text(
            encoding="utf-8"
        )
    )
    truth = json.loads(
        (generated_root / artifacts["identity_truth"]["path"]).read_text(
            encoding="utf-8"
        )
    )
    hard_negatives = json.loads(
        (generated_root / artifacts["hard_negatives"]["path"]).read_text(
            encoding="utf-8"
        )
    )
    report = run_falsification(
        a_headers,
        a_rows,
        b_headers,
        b_rows,
        mappings,
        candidate_config,
        truth,
        hard_negatives,
        manifest,
    )
    snapshot = json.loads(
        (
            ROOT
            / "evaluation"
            / "benchmarks"
            / "organizations-weak-identifiers-1500-v1"
            / "falsification-snapshot-v0.2.0.json"
        ).read_text(encoding="utf-8")
    )
    assert report["overall"]["candidatePairs"] == snapshot["candidatePairs"]
    assert report["overall"]["truePairsRetained"] == snapshot["truePairsRetained"]
    assert report["overall"]["candidateRecall"] == snapshot["candidateRecall"]
    assert report["stratifiedRecall"]["weakIdentifier"] == {
        "truePairsTotal": snapshot["weakIdentifierTotal"],
        "truePairsRetained": snapshot["weakIdentifierRetained"],
        "truePairsMissed": (
            snapshot["weakIdentifierTotal"] - snapshot["weakIdentifierRetained"]
        ),
        "candidateRecall": snapshot["weakIdentifierRecall"],
    }
    assert report["suppressionAnalysis"]["keysSuppressed"] == snapshot["suppressedKeys"]
    assert (
        report["hardNegativeCoverage"]["candidatePairsEntered"]
        == snapshot["hardNegativePairsEntered"]
    )
