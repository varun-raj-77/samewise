from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

WORKFLOW_CONTRACT_VERSION = "1.0.0"
MATCHER_VERSION = "baseline-matcher-v0.1.0"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ColumnProfile(StrictModel):
    name: str = Field(min_length=1)
    inferredType: Literal["string", "integer", "number", "boolean", "date", "unknown"]
    nullCount: int = Field(ge=0)
    nullRate: float = Field(ge=0, le=1)
    distinctCount: int = Field(ge=0)
    distinctRate: float = Field(ge=0, le=1)
    samples: list[str] = Field(max_length=3)


class DatasetProfile(StrictModel):
    contractVersion: Literal["1.0.0"]
    datasetId: str = Field(min_length=1)
    side: Literal["A", "B"]
    originalFilename: str = Field(min_length=1)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    rowCount: int = Field(ge=0)
    columns: list[ColumnProfile] = Field(min_length=1)


class ManualMapping(StrictModel):
    mappingId: str = Field(min_length=1)
    label: str = Field(min_length=1)
    aColumn: str = Field(min_length=1)
    bColumn: str = Field(min_length=1)
    role: Literal["identity", "comparison"]
    normalizer: Literal["text", "phone", "email", "number", "date"]


class FieldEvidence(StrictModel):
    mappingId: str
    label: str
    aColumn: str
    bColumn: str
    aValue: str
    bValue: str
    normalizedA: str
    normalizedB: str
    outcome: Literal["exact", "similar", "conflict", "missing_one", "missing_both"]
    contribution: float = Field(ge=0, le=1)
    explanation: str


class CandidatePair(StrictModel):
    candidateId: str
    aRowId: str
    bRowId: str
    aRecord: dict[str, str]
    bRecord: dict[str, str]
    rank: int = Field(gt=0)
    baselineScore: float = Field(ge=0, le=1)
    runnerUpMargin: float = Field(ge=0, le=1)
    band: Literal["proposed_match", "needs_review"]
    collision: bool
    evidence: list[FieldEvidence] = Field(min_length=1)


class MatcherResult(StrictModel):
    contractVersion: Literal["1.0.0"]
    matcherVersion: Literal["baseline-matcher-v0.1.0"]
    candidates: list[CandidatePair]
    onlyA: list[dict[str, object]]
    onlyB: list[dict[str, object]]


class ProfileRequest(StrictModel):
    operation: Literal["profile"]
    datasetId: str = Field(min_length=1)
    side: Literal["A", "B"]
    originalFilename: str = Field(min_length=1)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    path: str = Field(min_length=1)


class MatchRequest(StrictModel):
    operation: Literal["match"]
    aPath: str = Field(min_length=1)
    bPath: str = Field(min_length=1)
    mappings: list[ManualMapping] = Field(min_length=1)
