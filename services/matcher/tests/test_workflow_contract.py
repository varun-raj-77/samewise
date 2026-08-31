import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from samewise_matcher.workflow_models import (
    MATCHER_VERSION,
    WORKFLOW_CONTRACT_VERSION,
    ManualMapping,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
CONTRACT_ROOT = REPOSITORY_ROOT / "packages" / "contracts"
SCHEMA = json.loads(
    (CONTRACT_ROOT / "schemas" / "workflow" / "1.0.0.json").read_text()
)
EXAMPLES = json.loads(
    (CONTRACT_ROOT / "examples" / "workflow" / "1.0.0.json").read_text()
)


def test_workflow_literals_and_boundary_definitions_match_canonical_schema() -> None:
    assert SCHEMA["x-contract-version"] == WORKFLOW_CONTRACT_VERSION
    assert SCHEMA["$defs"]["matcherVersion"]["const"] == MATCHER_VERSION
    assert {"datasetProfile", "matcherResult", "profileRequest", "matchRequest"} <= set(
        SCHEMA["$defs"]
    )


@pytest.mark.parametrize(
    "example",
    EXAMPLES["manualMappings"]["valid"],
    ids=[item["name"] for item in EXAMPLES["manualMappings"]["valid"]],
)
def test_pydantic_accepts_shared_valid_mappings(example: dict[str, object]) -> None:
    ManualMapping.model_validate(example["value"])


@pytest.mark.parametrize(
    "example",
    EXAMPLES["manualMappings"]["invalid"],
    ids=[item["name"] for item in EXAMPLES["manualMappings"]["invalid"]],
)
def test_pydantic_rejects_shared_invalid_mappings(example: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        ManualMapping.model_validate(example["value"])
