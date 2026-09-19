"""Versioned, deterministic multi-field scoring over truth-blind candidates."""

from __future__ import annotations

import hashlib
import math
import time
from collections import Counter
from collections.abc import MutableMapping
from difflib import SequenceMatcher
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from samewise_matcher.baseline import _row_id, read_csv
from samewise_matcher.blocking_normalization import (
    NORMALIZATION_VERSION,
    address_number,
    normalize_address,
    normalize_domain,
    normalize_email,
    normalize_name,
    normalize_phone,
    normalize_postal,
    normalize_text,
)
from samewise_matcher.candidate_engine import (
    CANDIDATE_ENGINE_VERSION,
    CandidateEngineConfig,
    GeneratedCandidate,
    _mapping_kind,
    generate_candidates,
)
from samewise_matcher.workflow_models import (
    EVIDENCE_PLAN_VERSION,
    FEATURE_PIPELINE_VERSION,
    MATCHER_CONFIG_VERSION,
    MATCHER_VERSION,
    WORKFLOW_CONTRACT_VERSION,
    BlockingEvidenceView,
    CandidatePair,
    FeatureValue,
    FieldEvidence,
    ManualMapping,
    MatcherResult,
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class FieldWeights(StrictModel):
    persistent_identifier: float = Field(default=2.5, gt=0)
    source_local_identifier: float = Field(default=0.25, gt=0)
    name_or_title: float = Field(default=2.0, gt=0)
    contact_person: float = Field(default=0.75, gt=0)
    geography: float = Field(default=0.4, gt=0)
    categorical: float = Field(default=0.3, gt=0)
    numeric: float = Field(default=0.5, gt=0)
    date_or_timestamp: float = Field(default=0.3, gt=0)
    free_text: float = Field(default=0.25, gt=0)
    unknown: float = Field(default=0.25, gt=0)
    name: float = Field(default=2.0, gt=0)
    phone: float = Field(default=1.5, gt=0)
    email: float = Field(default=1.5, gt=0)
    domain: float = Field(default=1.0, gt=0)
    address: float = Field(default=1.5, gt=0)
    city: float = Field(default=0.3, gt=0)
    region: float = Field(default=0.3, gt=0)
    postal: float = Field(default=0.6, gt=0)
    other: float = Field(default=0.5, gt=0)


class ConflictMultipliers(StrictModel):
    persistent_identifier: float = Field(default=1.0, ge=0)
    source_local_identifier: float = Field(default=0.0, ge=0)
    name_or_title: float = Field(default=0.1, ge=0)
    contact_person: float = Field(default=0.1, ge=0)
    geography: float = Field(default=0.2, ge=0)
    categorical: float = Field(default=0.1, ge=0)
    numeric: float = Field(default=0.2, ge=0)
    date_or_timestamp: float = Field(default=0.1, ge=0)
    free_text: float = Field(default=0.1, ge=0)
    unknown: float = Field(default=0.1, ge=0)
    name: float = Field(default=0.1, ge=0)
    phone: float = Field(default=0.15, ge=0)
    email: float = Field(default=0.2, ge=0)
    domain: float = Field(default=0.15, ge=0)
    address: float = Field(default=0.2, ge=0)
    city: float = Field(default=0.2, ge=0)
    region: float = Field(default=0.2, ge=0)
    postal: float = Field(default=0.2, ge=0)
    other: float = Field(default=0.25, ge=0)


class DecisionRules(StrictModel):
    autoMatchThreshold: float = Field(default=0.50, ge=0, le=1)
    reviewThreshold: float = Field(default=0.25, ge=0, le=1)
    minimumTopCandidateMargin: float = Field(default=0.04, ge=0, le=1)
    minimumAutoAgreementFields: int = Field(default=2, ge=1)
    alternativeFloor: float = Field(default=0.25, ge=0, le=1)
    alternativeWindow: float = Field(default=0.30, ge=0, le=1)
    maxAlternatives: int = Field(default=3, ge=1, le=10)
    collisionPolicy: Literal["route_to_review"] = "route_to_review"
    contradictionPolicy: Literal["block_auto_match"] = "block_auto_match"


class MatcherConfig(StrictModel):
    matcherVersion: Literal[
        "explainable-matcher-v0.2.0", "explainable-matcher-v0.3.0"
    ] = MATCHER_VERSION
    configVersion: Literal["matcher-config-v0.2.0", "matcher-config-v0.3.0"] = (
        MATCHER_CONFIG_VERSION
    )
    featurePipelineVersion: Literal[
        "feature-pipeline-v0.1.0", "feature-pipeline-v0.2.0"
    ] = FEATURE_PIPELINE_VERSION
    candidateEngineVersion: Literal[
        "candidate-engine-v0.2.0",
        "candidate-engine-v0.3.0",
        "candidate-engine-v0.4.0",
    ] = CANDIDATE_ENGINE_VERSION
    blockingNormalizationVersion: Literal["blocking-normalization-v0.1.0"] = (
        NORMALIZATION_VERSION
    )
    frozen: bool = True
    tunedOnFixture: str | None = None
    weights: FieldWeights = Field(default_factory=FieldWeights)
    conflictMultipliers: ConflictMultipliers = Field(
        default_factory=ConflictMultipliers
    )
    decisions: DecisionRules = Field(default_factory=DecisionRules)


class ScoredPair(StrictModel):
    aRowId: str
    bRowId: str
    matchScore: float = Field(ge=0, le=1)
    positiveEvidence: float = Field(ge=0)
    conflictEvidence: float = Field(ge=0)
    totalWeight: float = Field(gt=0)
    agreementFields: int = Field(ge=0)
    strongContradiction: bool
    evidence: list[FieldEvidence] = Field(min_length=1)
    blockingEvidence: list[BlockingEvidenceView] = Field(min_length=1)


NormalizedRowCache = dict[str, tuple[str, ...]]
FrequencyContext = dict[str, tuple[Counter[str], Counter[str], int, int]]


def _bounded(value: float) -> float:
    if not math.isfinite(value):
        raise ValueError("Feature computation produced a non-finite value")
    return round(min(1.0, max(0.0, value)), 6)


def _ratio(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    return _bounded(SequenceMatcher(None, left, right, autojunk=False).ratio())


def _token_scores(left: str, right: str) -> tuple[float, float]:
    left_tokens = set(left.split())
    right_tokens = set(right.split())
    if not left_tokens or not right_tokens:
        return 0.0, 0.0
    intersection = len(left_tokens & right_tokens)
    union = len(left_tokens | right_tokens)
    return _bounded(intersection / union), _bounded(
        intersection / min(len(left_tokens), len(right_tokens))
    )


def _normalizer(kind: str):
    return {
        "persistent_identifier": normalize_text,
        "source_local_identifier": normalize_text,
        "name_or_title": normalize_name,
        "contact_person": normalize_name,
        "name": normalize_name,
        "phone": normalize_phone,
        "email": normalize_email,
        "domain": normalize_domain,
        "address": normalize_address,
        "city": normalize_text,
        "region": normalize_text,
        "postal": normalize_postal,
        "geography": normalize_text,
        "categorical": normalize_text,
        "numeric": normalize_text,
        "date_or_timestamp": normalize_text,
        "free_text": normalize_text,
        "unknown": normalize_text,
        "other": normalize_text,
    }[kind]


def _feature(name: str, value: float) -> FeatureValue:
    return FeatureValue(name=name, value=_bounded(value))


def _field_strengths(
    kind: str, left: str, right: str, *, semantic_mode: bool = False
) -> tuple[list[FeatureValue], float, float, str, str, str]:
    """Return features, positive strength, conflict strength, class/code/text."""

    exact = float(left == right)
    if (
        kind
        in {
            "persistent_identifier",
            "source_local_identifier",
            "categorical",
            "numeric",
            "date_or_timestamp",
            "free_text",
            "unknown",
        }
        or kind == "phone"
    ):
        features = [_feature("normalized_exact", exact)]
        positive, conflict = exact, 1.0 - exact
    elif kind == "email":
        left_local, _, left_domain = left.partition("@")
        right_local, _, right_domain = right.partition("@")
        local = float(bool(left_local) and left_local == right_local)
        domain = float(bool(left_domain) and left_domain == right_domain)
        character = _ratio(left, right)
        features = [
            _feature("normalized_exact", exact),
            _feature("local_part_exact", local),
            _feature("domain_exact", domain),
            _feature("character_similarity", character),
        ]
        positive = (
            exact if semantic_mode else exact or _bounded(0.7 * local + 0.3 * domain)
        )
        conflict = (
            1.0 - exact
            if semantic_mode
            else 0.0
            if exact
            else _bounded(1.0 - 0.5 * local - 0.2 * domain)
        )
    elif kind == "domain":
        features = [_feature("normalized_host_exact", exact)]
        positive, conflict = exact, 1.0 - exact
    elif kind in {"name", "name_or_title", "contact_person"}:
        character = _ratio(left, right)
        token, overlap = _token_scores(left, right)
        features = [
            _feature("normalized_exact", exact),
            _feature("character_similarity", character),
            _feature("token_similarity", token),
            _feature("meaningful_token_overlap", overlap),
        ]
        positive = exact or _bounded(0.45 * character + 0.4 * token + 0.15 * overlap)
        conflict = 0.0 if exact else _bounded(max(0.0, 0.55 - positive))
    elif kind == "address":
        character = _ratio(left, right)
        token, overlap = _token_scores(left, right)
        left_number = address_number(left)
        right_number = address_number(right)
        number = float(bool(left_number) and left_number == right_number)
        number_conflict = float(
            bool(left_number) and bool(right_number) and left_number != right_number
        )
        features = [
            _feature("normalized_exact", exact),
            _feature("house_number_exact", number),
            _feature("token_similarity", token),
            _feature("meaningful_token_overlap", overlap),
            _feature("character_similarity", character),
            _feature("house_number_conflict", number_conflict),
        ]
        positive = exact or _bounded(
            0.35 * number + 0.25 * token + 0.15 * overlap + 0.25 * character
        )
        conflict = _bounded(max(number_conflict, (1.0 - positive) * 0.35))
    else:
        character = _ratio(left, right)
        token, overlap = _token_scores(left, right)
        features = [
            _feature("normalized_exact", exact),
            _feature("character_similarity", character),
            _feature("token_similarity", token),
            _feature("meaningful_token_overlap", overlap),
        ]
        if kind in {"city", "region", "postal", "geography"}:
            positive = exact or (
                _bounded(character * 0.5) if character >= 0.88 else 0.0
            )
            conflict = 0.0 if exact else 1.0
        else:
            positive = exact or _bounded(
                0.55 * character + 0.3 * token + 0.15 * overlap
            )
            conflict = 0.0 if exact else _bounded(max(0.0, 0.5 - positive))

    positive = float(positive)
    if exact:
        evidence_class = "exact_agreement"
        code = f"{kind}_exact"
        explanation = f"{kind.replace('_', ' ').title()} matches after normalization."
    elif positive >= 0.35 and positive >= conflict:
        evidence_class = "partial_agreement"
        code = f"{kind}_partial"
        explanation = (
            f"{kind.replace('_', ' ').title()} has partial normalized agreement."
        )
    else:
        evidence_class = "conflict"
        code = f"{kind}_conflict"
        explanation = f"Non-empty normalized {kind.replace('_', ' ')} values conflict."
    return (
        features,
        _bounded(positive),
        _bounded(conflict),
        evidence_class,
        code,
        explanation,
    )


def compute_field_evidence(
    mapping: ManualMapping,
    a_value: str,
    b_value: str,
    config: MatcherConfig,
) -> FieldEvidence:
    if mapping.role != "identity":
        raise ValueError(
            "Comparison mappings cannot enter the identity feature pipeline"
        )
    kind = _mapping_kind(mapping)
    normalized_a = _normalizer(kind)(a_value)
    normalized_b = _normalizer(kind)(b_value)
    return _compute_field_evidence_normalized(
        mapping,
        a_value,
        b_value,
        normalized_a,
        normalized_b,
        kind,
        config,
        (
            int(bool(normalized_a)),
            int(bool(normalized_b)),
            int(bool(normalized_a)),
            int(bool(normalized_b)),
        ),
    )


def _compute_field_evidence_normalized(
    mapping: ManualMapping,
    a_value: str,
    b_value: str,
    normalized_a: str,
    normalized_b: str,
    kind: str,
    config: MatcherConfig,
    frequency: tuple[int, int, int, int] | None = None,
) -> FieldEvidence:
    weight = getattr(config.weights, kind)
    conflict_multiplier = getattr(config.conflictMultipliers, kind)
    if not normalized_a and not normalized_b:
        features: list[FeatureValue] = []
        evidence_class = "missing_both"
        positive = conflict = 0.0
        code = f"{kind}_missing_both"
        explanation = "Both mapped values are missing; this field is neutral."
    elif not normalized_a:
        features = []
        evidence_class = "missing_left"
        positive = conflict = 0.0
        code = f"{kind}_missing_left"
        explanation = "Dataset A is missing this value; this field is neutral."
    elif not normalized_b:
        features = []
        evidence_class = "missing_right"
        positive = conflict = 0.0
        code = f"{kind}_missing_right"
        explanation = "Dataset B is missing this value; this field is neutral."
    else:
        (
            features,
            positive,
            conflict,
            evidence_class,
            code,
            explanation,
        ) = _field_strengths(
            kind,
            normalized_a,
            normalized_b,
            semantic_mode=mapping.semanticFamily != "unknown",
        )
    frequency_a, frequency_b, row_count_a, row_count_b = frequency or (0, 0, 0, 0)
    max_frequency = max(frequency_a, frequency_b)
    # Frequency is classified and exposed for planning, warnings, signatures,
    # and safeguards, but it does not rescale production scores. An inverse-
    # frequency scoring experiment materially reduced recovery on the frozen
    # holdout, so applying it would violate the acceptance gate.
    information_multiplier = 1.0
    if not normalized_a or not normalized_b:
        information_class = "not_applicable"
    elif max_frequency <= 0:
        information_class = "unknown"
    elif max_frequency == 1:
        information_class = "distinctive"
    elif (
        max(
            frequency_a / row_count_a if row_count_a else 0,
            frequency_b / row_count_b if row_count_b else 0,
        )
        >= 0.05
    ):
        information_class = "common"
    else:
        information_class = "repeated"
    positive_contribution = round(weight * positive * information_multiplier, 6)
    conflict_contribution = round(weight * conflict_multiplier * conflict, 6)
    return FieldEvidence(
        mappingId=mapping.mappingId,
        label=mapping.label,
        aColumn=mapping.aColumn,
        bColumn=mapping.bColumn,
        aValue=a_value,
        bValue=b_value,
        normalizedA=normalized_a,
        normalizedB=normalized_b,
        fieldKind=kind,
        featurePipelineVersion=config.featurePipelineVersion,
        features=features,
        outcome=(
            "exact"
            if evidence_class == "exact_agreement"
            else "similar"
            if evidence_class == "partial_agreement"
            else "missing_both"
            if evidence_class == "missing_both"
            else "missing_one"
            if evidence_class in {"missing_left", "missing_right"}
            else "conflict"
        ),
        evidenceClass=evidence_class,
        weight=weight,
        positiveContribution=positive_contribution,
        conflictContribution=conflict_contribution,
        contribution=round(positive_contribution - conflict_contribution, 6),
        explanationCode=code,
        explanation=explanation,
        valueFrequencyA=frequency_a,
        valueFrequencyB=frequency_b,
        informationClass=information_class,
        informationMultiplier=information_multiplier,
    )


def score_candidate(
    a_row_id: str,
    b_row_id: str,
    a_row: dict[str, str],
    b_row: dict[str, str],
    identity_mappings: list[ManualMapping],
    blocking_evidence: list[BlockingEvidenceView],
    config: MatcherConfig,
) -> ScoredPair:
    evidence = [
        compute_field_evidence(
            mapping, a_row[mapping.aColumn], b_row[mapping.bColumn], config
        )
        for mapping in identity_mappings
    ]
    return _score_candidate_evidence(a_row_id, b_row_id, evidence, blocking_evidence)


def _score_candidate_evidence(
    a_row_id: str,
    b_row_id: str,
    evidence: list[FieldEvidence],
    blocking_evidence: list[BlockingEvidenceView],
) -> ScoredPair:
    # The denominator is fixed by confirmed identity mappings. Missing values add
    # no evidence and cannot inflate the score by shrinking the denominator.
    total_weight = round(sum(item.weight for item in evidence), 6)
    positive = round(sum(item.positiveContribution for item in evidence), 6)
    conflict = round(sum(item.conflictContribution for item in evidence), 6)
    score = _bounded((positive - conflict) / total_weight)
    agreement_fields = sum(
        item.evidenceClass in {"exact_agreement", "partial_agreement"}
        and item.positiveContribution > 0
        for item in evidence
    )
    strong_contradiction = any(
        (
            item.fieldKind in {"persistent_identifier", "email", "domain"}
            or (
                item.fieldKind == "phone"
                and item.featurePipelineVersion != FEATURE_PIPELINE_VERSION
            )
        )
        and item.evidenceClass == "conflict"
        and item.conflictContribution > 0
        for item in evidence
    )
    return ScoredPair(
        aRowId=a_row_id,
        bRowId=b_row_id,
        matchScore=score,
        positiveEvidence=positive,
        conflictEvidence=conflict,
        totalWeight=total_weight,
        agreementFields=agreement_fields,
        strongContradiction=strong_contradiction,
        evidence=evidence,
        blockingEvidence=blocking_evidence,
    )


def _normalized_row_cache(
    rows_by_id: dict[str, dict[str, str]],
    identity_mappings: list[ManualMapping],
    side: Literal["A", "B"],
) -> NormalizedRowCache:
    prepared = [
        (
            mapping.aColumn if side == "A" else mapping.bColumn,
            _normalizer(_mapping_kind(mapping)),
        )
        for mapping in identity_mappings
    ]
    return {
        row_id: tuple(normalizer(row[column]) for column, normalizer in prepared)
        for row_id, row in rows_by_id.items()
    }


def _frequency_context(
    a_cache: NormalizedRowCache,
    b_cache: NormalizedRowCache,
    identity_mappings: list[ManualMapping],
) -> FrequencyContext:
    context: FrequencyContext = {}
    for index, mapping in enumerate(identity_mappings):
        a_values = [values[index] for values in a_cache.values() if values[index]]
        b_values = [values[index] for values in b_cache.values() if values[index]]
        context[mapping.mappingId] = (
            Counter(a_values),
            Counter(b_values),
            len(a_values),
            len(b_values),
        )
    return context


def build_evidence_plan(
    a_by_id: dict[str, dict[str, str]],
    b_by_id: dict[str, dict[str, str]],
    identity_mappings: list[ManualMapping],
    *,
    candidate_mode: Literal["candidate_engine", "all_pairs"] = "candidate_engine",
    candidate_config: CandidateEngineConfig | None = None,
) -> dict[str, object]:
    a_cache = _normalized_row_cache(a_by_id, identity_mappings, "A")
    b_cache = _normalized_row_cache(b_by_id, identity_mappings, "B")
    frequencies = _frequency_context(a_cache, b_cache, identity_mappings)
    comparator = {
        "persistent_identifier": "normalized_exact_identifier",
        "source_local_identifier": "normalized_exact_supporting",
        "name_or_title": "normalized_name_similarity",
        "contact_person": "normalized_name_similarity_supporting",
        "email": "normalized_exact_email",
        "phone": "normalized_exact_phone",
        "domain": "normalized_exact_domain",
        "address": "normalized_address_similarity",
        "geography": "normalized_exact_supporting",
        "categorical": "normalized_exact_supporting",
        "numeric": "normalized_exact",
        "date_or_timestamp": "normalized_exact",
        "free_text": "normalized_exact_supporting",
        "unknown": "normalized_exact_supporting",
    }
    plans: list[dict[str, object]] = []
    for mapping in identity_mappings:
        a_counts, b_counts, a_count, b_count = frequencies[mapping.mappingId]
        exact_overlap = len(set(a_counts) & set(b_counts))
        plans.append(
            {
                "mappingId": mapping.mappingId,
                "semanticFamily": mapping.semanticFamily,
                "comparator": comparator.get(
                    mapping.semanticFamily, "legacy_inferred_comparator"
                ),
                "nonNullCountA": a_count,
                "nonNullCountB": b_count,
                "normalizedDistinctCountA": len(a_counts),
                "normalizedDistinctCountB": len(b_counts),
                "mostCommonValueCountA": max(a_counts.values(), default=0),
                "mostCommonValueCountB": max(b_counts.values(), default=0),
                "crossSourceExactOverlapCount": exact_overlap,
                "informationAdjustment": "classification_only_no_score_adjustment",
            }
        )
    return {
        "version": EVIDENCE_PLAN_VERSION,
        "frequencyAdjustment": "classification_only_no_score_adjustment",
        "candidateStrategy": (
            {
                "mode": "candidate_engine",
                "config": (candidate_config or CandidateEngineConfig()).model_dump(
                    mode="json"
                ),
            }
            if candidate_mode == "candidate_engine"
            else {"mode": "all_pairs_evaluation_oracle"}
        ),
        "mappings": plans,
    }


def score_generated_candidates(
    generated: list[GeneratedCandidate],
    a_by_id: dict[str, dict[str, str]],
    b_by_id: dict[str, dict[str, str]],
    identity_mappings: list[ManualMapping],
    config: MatcherConfig,
    *,
    performance_timings: MutableMapping[str, float] | None = None,
) -> list[ScoredPair]:
    """Score candidates with one normalized representation per row and mapping."""

    cache_started = time.perf_counter()
    a_cache = _normalized_row_cache(a_by_id, identity_mappings, "A")
    b_cache = _normalized_row_cache(b_by_id, identity_mappings, "B")
    frequencies = _frequency_context(a_cache, b_cache, identity_mappings)
    if performance_timings is not None:
        performance_timings["feature_normalization_cache_seconds"] = round(
            time.perf_counter() - cache_started, 6
        )

    kinds = [_mapping_kind(mapping) for mapping in identity_mappings]
    feature_seconds = 0.0
    scoring_seconds = 0.0
    scored: list[ScoredPair] = []
    for candidate in generated:
        a_row = a_by_id[candidate.aRowId]
        b_row = b_by_id[candidate.bRowId]
        feature_started = time.perf_counter()
        evidence = [
            _compute_field_evidence_normalized(
                mapping,
                a_row[mapping.aColumn],
                b_row[mapping.bColumn],
                a_cache[candidate.aRowId][index],
                b_cache[candidate.bRowId][index],
                kinds[index],
                config,
                (
                    frequencies[mapping.mappingId][0].get(
                        a_cache[candidate.aRowId][index], 0
                    ),
                    frequencies[mapping.mappingId][1].get(
                        b_cache[candidate.bRowId][index], 0
                    ),
                    frequencies[mapping.mappingId][2],
                    frequencies[mapping.mappingId][3],
                ),
            )
            for index, mapping in enumerate(identity_mappings)
        ]
        feature_seconds += time.perf_counter() - feature_started
        scoring_started = time.perf_counter()
        scored.append(
            _score_candidate_evidence(
                candidate.aRowId,
                candidate.bRowId,
                evidence,
                [
                    BlockingEvidenceView.model_validate(item.model_dump())
                    for item in candidate.blockingEvidence
                ],
            )
        )
        scoring_seconds += time.perf_counter() - scoring_started
    if performance_timings is not None:
        performance_timings["feature_extraction_seconds"] = round(feature_seconds, 6)
        performance_timings["scoring_seconds"] = round(scoring_seconds, 6)
    return scored


def _oracle_candidate(
    a_row_id: str, b_row_id: str, a_index: int, b_index: int
) -> GeneratedCandidate:
    key_hash = hashlib.sha256(f"all-pairs\0{a_index}\0{b_index}".encode()).hexdigest()[
        :16
    ]
    return GeneratedCandidate(
        candidateId=f"candidate-{hashlib.sha256(f'{a_row_id}\0{b_row_id}'.encode()).hexdigest()[:20]}",
        aRowId=a_row_id,
        bRowId=b_row_id,
        blockingEvidence=[{"blockerId": "name_character_v1", "keyHash": key_hash}],
    )


def score_rows(
    a_headers: list[str],
    a_rows: list[dict[str, str]],
    b_headers: list[str],
    b_rows: list[dict[str, str]],
    mappings: list[ManualMapping],
    config: MatcherConfig,
    *,
    candidate_mode: Literal["candidate_engine", "all_pairs"] = "candidate_engine",
    candidate_config: CandidateEngineConfig | None = None,
) -> tuple[list[ScoredPair], dict[str, list[GeneratedCandidate]]]:
    identity = [mapping for mapping in mappings if mapping.role == "identity"]
    if not identity:
        raise ValueError("At least one identity mapping is required")
    for mapping in mappings:
        if mapping.aColumn not in a_headers or mapping.bColumn not in b_headers:
            raise ValueError("A mapping references a column that does not exist")
    a_by_id = {
        _row_id(row, a_headers, "A", index): row for index, row in enumerate(a_rows)
    }
    b_by_id = {
        _row_id(row, b_headers, "B", index): row for index, row in enumerate(b_rows)
    }
    if candidate_mode == "candidate_engine":
        effective_candidate_config = candidate_config or CandidateEngineConfig()
        if effective_candidate_config.engineVersion != config.candidateEngineVersion:
            raise ValueError(
                "Candidate engine config version must match frozen matcher provenance"
            )
        if (
            effective_candidate_config.normalizationVersion
            != config.blockingNormalizationVersion
        ):
            raise ValueError(
                "Blocking normalization version must match frozen matcher provenance"
            )
        generated = generate_candidates(
            a_headers,
            a_rows,
            b_headers,
            b_rows,
            mappings,
            effective_candidate_config,
        ).candidates
    else:
        generated = [
            _oracle_candidate(a_id, b_id, a_index, b_index)
            for a_index, a_id in enumerate(a_by_id)
            for b_index, b_id in enumerate(b_by_id)
        ]
    by_a: dict[str, list[GeneratedCandidate]] = {row_id: [] for row_id in a_by_id}
    for candidate in generated:
        by_a[candidate.aRowId].append(candidate)
    scored = score_generated_candidates(generated, a_by_id, b_by_id, identity, config)
    return scored, by_a


def build_match_result(
    a_headers: list[str],
    a_rows: list[dict[str, str]],
    b_headers: list[str],
    b_rows: list[dict[str, str]],
    scored: list[ScoredPair],
    config: MatcherConfig,
    evidence_plan: dict[str, object] | None = None,
) -> MatcherResult:
    a_by_id = {
        _row_id(row, a_headers, "A", index): row for index, row in enumerate(a_rows)
    }
    b_by_id = {
        _row_id(row, b_headers, "B", index): row for index, row in enumerate(b_rows)
    }
    ranked_by_a: dict[str, list[ScoredPair]] = {row_id: [] for row_id in a_by_id}
    for item in scored:
        ranked_by_a[item.aRowId].append(item)
    for items in ranked_by_a.values():
        items.sort(key=lambda item: (-item.matchScore, item.bRowId))
    preferred_b_counts = Counter(
        items[0].bRowId
        for items in ranked_by_a.values()
        if items and items[0].matchScore >= config.decisions.reviewThreshold
    )

    candidates: list[CandidatePair] = []
    only_a: list[dict[str, object]] = []
    auto_b: set[str] = set()
    for a_row_id, ranked in ranked_by_a.items():
        if not ranked or ranked[0].matchScore < config.decisions.reviewThreshold:
            only_a.append({"rowId": a_row_id, "record": a_by_id[a_row_id]})
            continue
        top = ranked[0]
        runner_up = ranked[1].matchScore if len(ranked) > 1 else 0.0
        margin = _bounded(top.matchScore - runner_up)
        collision = preferred_b_counts[top.bRowId] > 1
        auto = (
            top.matchScore >= config.decisions.autoMatchThreshold
            and margin >= config.decisions.minimumTopCandidateMargin
            and top.agreementFields >= config.decisions.minimumAutoAgreementFields
            and not top.strongContradiction
            and not collision
        )
        cutoff = max(
            config.decisions.alternativeFloor,
            top.matchScore - config.decisions.alternativeWindow,
        )
        alternatives = [item for item in ranked if item.matchScore >= cutoff][
            : config.decisions.maxAlternatives
        ]
        for rank, item in enumerate(alternatives, start=1):
            if rank == 1 and auto:
                auto_b.add(item.bRowId)
            candidates.append(
                CandidatePair(
                    candidateId=f"candidate-{hashlib.sha256(f'{item.aRowId}\0{item.bRowId}'.encode()).hexdigest()[:20]}",
                    aRowId=item.aRowId,
                    bRowId=item.bRowId,
                    aRecord=a_by_id[item.aRowId],
                    bRecord=b_by_id[item.bRowId],
                    rank=rank,
                    matchScore=item.matchScore,
                    runnerUpMargin=margin if rank == 1 else 0.0,
                    band="auto_match" if rank == 1 and auto else "needs_review",
                    collision=collision if rank == 1 else False,
                    strongContradiction=item.strongContradiction,
                    blockingEvidence=item.blockingEvidence,
                    positiveEvidence=item.positiveEvidence,
                    conflictEvidence=item.conflictEvidence,
                    totalWeight=item.totalWeight,
                    evidence=item.evidence,
                )
            )
    only_b = [
        {"rowId": row_id, "record": row}
        for row_id, row in b_by_id.items()
        if row_id not in auto_b
    ]
    return MatcherResult(
        contractVersion=WORKFLOW_CONTRACT_VERSION,
        matcherVersion=config.matcherVersion,
        candidateEngineVersion=config.candidateEngineVersion,
        blockingNormalizationVersion=NORMALIZATION_VERSION,
        featurePipelineVersion=config.featurePipelineVersion,
        matcherConfigVersion=config.configVersion,
        matcherConfig=config.model_dump(mode="json"),
        evidencePlanVersion=EVIDENCE_PLAN_VERSION,
        evidencePlan=evidence_plan
        or {
            "version": EVIDENCE_PLAN_VERSION,
            "availability": "not_supplied_by_caller",
        },
        candidates=candidates,
        onlyA=only_a,
        onlyB=only_b,
    )


def match_csvs_explainable(
    a_path: Path,
    b_path: Path,
    mappings: list[ManualMapping],
    *,
    candidate_mode: Literal["candidate_engine", "all_pairs"] = "candidate_engine",
    candidate_config: CandidateEngineConfig | None = None,
    matcher_config: MatcherConfig | None = None,
) -> MatcherResult:
    config = matcher_config or MatcherConfig()
    a_headers, a_rows = read_csv(a_path)
    b_headers, b_rows = read_csv(b_path)
    scored, _ = score_rows(
        a_headers,
        a_rows,
        b_headers,
        b_rows,
        mappings,
        config,
        candidate_mode=candidate_mode,
        candidate_config=candidate_config,
    )
    identity_mappings = [mapping for mapping in mappings if mapping.role == "identity"]
    a_by_id = {
        _row_id(row, a_headers, "A", index): row for index, row in enumerate(a_rows)
    }
    b_by_id = {
        _row_id(row, b_headers, "B", index): row for index, row in enumerate(b_rows)
    }
    evidence_plan = build_evidence_plan(
        a_by_id,
        b_by_id,
        identity_mappings,
        candidate_mode=candidate_mode,
        candidate_config=candidate_config,
    )
    return build_match_result(
        a_headers,
        a_rows,
        b_headers,
        b_rows,
        scored,
        config,
        evidence_plan,
    )
