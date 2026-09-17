import importlib.util
from pathlib import Path


def test_sw013_scenarios_are_isolated_and_deterministic() -> None:
    root = Path(__file__).resolve().parents[3]
    script = root / "evaluation" / "competitors" / "sw-013" / "validate.py"
    spec = importlib.util.spec_from_file_location("sw013_validate", script)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    artifact = module.run_suite(write=False)

    assert artifact["artifactVersion"] == "sw-013-scenario-results-v1"
    assert len(artifact["scenarios"]) == 10
    assert {item["scenarioId"] for item in artifact["scenarios"]} == {
        f"S{index:02d}" for index in range(1, 11)
    }
