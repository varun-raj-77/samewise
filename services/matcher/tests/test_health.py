import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from samewise_matcher.cli import main
from samewise_matcher.contracts import (
    HEALTH_RESPONSE_CONTRACT_VERSION,
    HealthResponse,
    create_health_response,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
CONTRACT_ROOT = REPOSITORY_ROOT / "packages" / "contracts"
SCHEMA_PATH = CONTRACT_ROOT / "schemas" / "health-response" / "1.0.0.json"
EXAMPLES_PATH = CONTRACT_ROOT / "examples" / "health-response" / "1.0.0.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
EXAMPLES = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))


def test_health_response_matches_contract() -> None:
    health = create_health_response("matcher")

    assert health.model_dump() == {
        "service": "matcher",
        "status": "ok",
        "contractVersion": "1.0.0",
    }


@pytest.mark.parametrize(
    "example",
    EXAMPLES["valid"],
    ids=[example["name"] for example in EXAMPLES["valid"]],
)
def test_pydantic_accepts_shared_valid_examples(example: dict[str, object]) -> None:
    HealthResponse.model_validate(example["value"])


@pytest.mark.parametrize(
    "example",
    EXAMPLES["invalid"],
    ids=[example["name"] for example in EXAMPLES["invalid"]],
)
def test_pydantic_rejects_shared_invalid_examples(example: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        HealthResponse.model_validate(example["value"])


def test_health_cli_emits_machine_readable_json(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["health"]) == 0

    output = json.loads(capsys.readouterr().out)
    validated = HealthResponse.model_validate(output)
    assert validated.service == "matcher"


def test_pydantic_model_stays_synchronized_with_json_schema() -> None:
    assert SCHEMA["required"] == ["service", "status", "contractVersion"]
    assert SCHEMA["additionalProperties"] is False
    assert SCHEMA["properties"]["service"] == {"type": "string", "minLength": 1}
    assert SCHEMA["properties"]["status"]["const"] == "ok"
    assert (
        SCHEMA["properties"]["contractVersion"]["const"]
        == HEALTH_RESPONSE_CONTRACT_VERSION
    )
    assert SCHEMA["x-contract-version"] == HEALTH_RESPONSE_CONTRACT_VERSION
    assert EXAMPLES["contractVersion"] == HEALTH_RESPONSE_CONTRACT_VERSION
