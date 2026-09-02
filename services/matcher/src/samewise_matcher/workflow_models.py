from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

WORKFLOW_CONTRACT_VERSION = "1.0.0"
MATCHER_VERSION = "explainable-matcher-v0.2.0"
LEGACY_MATCHER_VERSION = "baseline-matcher-v0.1.0"
FEATURE_PIPELINE_VERSION = "feature-pipeline-v0.1.0"
MATCHER_CONFIG_VERSION = "matcher-config-v0.2.0"


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


class FeatureValue(StrictModel):
    name: str = Field(min_length=1)
    value: float = Field(ge=0, le=1)


class BlockingEvidenceView(StrictModel):
    blockerId: str = Field(min_length=1)
    keyHash: str = Field(pattern=r"^[a-f0-9]{16}$")


class FieldEvidence(StrictModel):
    mappingId: str
    label: str
    aColumn: str
    bColumn: str
    aValue: str
    bValue: str
    normalizedA: str
    normalizedB: str
    fieldKind: Literal[
        "name",
        "phone",
        "email",
        "domain",
        "address",
        "city",
        "region",
        "postal",
        "other",
    ]
    featurePipelineVersion: Literal[
        "baseline-feature-pipeline-v0.1.0", "feature-pipeline-v0.1.0"
    ]
    features: list[FeatureValue]
    outcome: Literal["exact", "similar", "conflict", "missing_one", "missing_both"]
    evidenceClass: Literal[
        "exact_agreement",
        "partial_agreement",
        "conflict",
        "missing_left",
        "missing_right",
        "missing_both",
    ]
    weight: float = Field(gt=0)
    positiveContribution: float = Field(ge=0)
    conflictContribution: float = Field(ge=0)
    contribution: float
    explanationCode: str = Field(min_length=1)
    explanation: str


class CandidatePair(StrictModel):
    candidateId: str
    aRowId: str
    bRowId: str
    aRecord: dict[str, str]
    bRecord: dict[str, str]
    rank: int = Field(gt=0)
    matchScore: float = Field(ge=0, le=1)
    runnerUpMargin: float = Field(ge=0, le=1)
    band: Literal["auto_match", "needs_review"]
    collision: bool
    strongContradiction: bool
    blockingEvidence: list[BlockingEvidenceView] = Field(min_length=1)
    positiveEvidence: float = Field(ge=0)
    conflictEvidence: float = Field(ge=0)
    totalWeight: float = Field(gt=0)
    evidence: list[FieldEvidence] = Field(min_length=1)


class MatcherResult(StrictModel):
    contractVersion: Literal["1.0.0"]
    matcherVersion: Literal["baseline-matcher-v0.1.0", "explainable-matcher-v0.2.0"]
    candidateEngineVersion: Literal["candidate-engine-v0.2.0"]
    blockingNormalizationVersion: Literal["blocking-normalization-v0.1.0"]
    featurePipelineVersion: Literal[
        "baseline-feature-pipeline-v0.1.0", "feature-pipeline-v0.1.0"
    ]
    matcherConfigVersion: Literal["baseline-config-v0.1.0", "matcher-config-v0.2.0"]
    matcherConfig: dict[str, object]
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
    candidateMode: Literal["candidate_engine", "all_pairs"] = "candidate_engine"
    matcherVersion: Literal["baseline-matcher-v0.1.0", "explainable-matcher-v0.2.0"] = (
        MATCHER_VERSION
    )
