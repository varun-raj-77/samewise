from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

HEALTH_RESPONSE_CONTRACT_VERSION = "1.0.0"


class HealthResponse(BaseModel):
    """Runtime representation of the canonical HealthResponse contract."""

    model_config = ConfigDict(extra="forbid")

    service: str = Field(min_length=1)
    status: Literal["ok"]
    contractVersion: Literal["1.0.0"]


def create_health_response(service: str) -> HealthResponse:
    return HealthResponse(
        service=service,
        status="ok",
        contractVersion=HEALTH_RESPONSE_CONTRACT_VERSION,
    )
