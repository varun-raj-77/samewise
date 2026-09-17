"""Truth-blind multi-pass candidate generation over visible source records."""

from __future__ import annotations

import hashlib
import time
from collections import defaultdict
from collections.abc import Iterable, MutableMapping
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from samewise_matcher.blocking_normalization import (
    NORMALIZATION_VERSION,
    address_number,
    name_tokens,
    normalize_address,
    normalize_domain,
    normalize_email,
    normalize_name,
    normalize_phone,
    normalize_postal,
    normalize_text,
)
from samewise_matcher.workflow_models import ManualMapping

CANDIDATE_ENGINE_VERSION = "candidate-engine-v0.2.0"
BlockerId = Literal[
    "exact_strong_v1",
    "name_token_v1",
    "name_character_v1",
    "location_name_v1",
    "address_name_v1",
    "location_name_v2",
    "address_name_v2",
]
V1_BLOCKERS: tuple[BlockerId, ...] = (
    "exact_strong_v1",
    "name_token_v1",
    "name_character_v1",
    "location_name_v1",
    "address_name_v1",
)
DEFAULT_BLOCKERS: tuple[BlockerId, ...] = (
    "exact_strong_v1",
    "name_token_v1",
    "name_character_v1",
    "location_name_v2",
    "address_name_v2",
)
DEFAULT_STOP_TOKENS = (
    "and",
    "company",
    "corporation",
    "group",
    "inc",
    "incorporated",
    "llc",
    "ltd",
    "limited",
    "of",
    "services",
    "solutions",
    "the",
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CandidateEngineConfig(StrictModel):
    engineVersion: Literal["candidate-engine-v0.1.0", "candidate-engine-v0.2.0"] = (
        CANDIDATE_ENGINE_VERSION
    )
    normalizationVersion: Literal["blocking-normalization-v0.1.0"] = (
        NORMALIZATION_VERSION
    )
    enabledBlockers: tuple[BlockerId, ...] = DEFAULT_BLOCKERS
    stopTokens: tuple[str, ...] = DEFAULT_STOP_TOKENS
    namePrefixLength: int = Field(default=4, ge=3, le=8)
    maxBucketSizePerSide: int = Field(default=20, ge=2)
    maxBucketPairCount: int = Field(default=100, ge=4)


class BlockingEvidence(StrictModel):
    blockerId: BlockerId
    keyHash: str = Field(pattern=r"^[a-f0-9]{16}$")


class GeneratedCandidate(StrictModel):
    candidateId: str = Field(pattern=r"^candidate-[a-f0-9]{20}$")
    aRowId: str
    bRowId: str
    blockingEvidence: list[BlockingEvidence] = Field(min_length=1)


class BlockerDiagnostics(StrictModel):
    blockerId: BlockerId
    keysConsidered: int = Field(ge=0)
    keysUsed: int = Field(ge=0)
    keysSuppressed: int = Field(ge=0)
    relationshipsGenerated: int = Field(ge=0)
    relationshipsSuppressed: int = Field(ge=0)
    suppressedKeyHashes: list[str]


class CandidateGenerationResult(StrictModel):
    engineVersion: Literal["candidate-engine-v0.1.0", "candidate-engine-v0.2.0"]
    normalizationVersion: Literal["blocking-normalization-v0.1.0"]
    config: CandidateEngineConfig
    aRowCount: int = Field(ge=0)
    bRowCount: int = Field(ge=0)
    candidates: list[GeneratedCandidate]
    zeroCandidateARowIds: list[str]
    zeroCandidateBRowIds: list[str]
    blockerDiagnostics: list[BlockerDiagnostics]


def _mapping_kind(mapping: ManualMapping) -> str:
    text = " ".join(
        (mapping.mappingId, mapping.label, mapping.aColumn, mapping.bColumn)
    ).casefold()
    if mapping.normalizer == "phone" or "phone" in text or "telephone" in text:
        return "phone"
    if mapping.normalizer == "email" or "email" in text:
        return "email"
    if "website" in text or "domain" in text or "url" in text:
        return "domain"
    if "postal" in text or "zip" in text:
        return "postal"
    if "city" in text:
        return "city"
    if "state" in text or "region" in text or "province" in text:
        return "region"
    if "street" in text or "address" in text:
        return "address"
    if "name" in text or "organization" in text or "company" in text:
        return "name"
    return "other"


def _key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def _candidate_id(a_row_id: str, b_row_id: str) -> str:
    digest = hashlib.sha256(f"{a_row_id}\0{b_row_id}".encode()).hexdigest()[:20]
    return f"candidate-{digest}"


def _row_ids(rows: list[dict[str, str]], headers: list[str], side: str) -> list[str]:
    return [
        row.get(headers[0], "").strip() or f"{side}-{index + 1}"
        for index, row in enumerate(rows)
    ]


def _meaningful_tokens(value: str, stop: frozenset[str]) -> set[str]:
    return {
        token for token in name_tokens(value) if token not in stop and len(token) >= 3
    }


def record_blocking_keys(
    row: dict[str, str],
    side: Literal["A", "B"],
    mappings: list[ManualMapping],
    config: CandidateEngineConfig,
    *,
    mapping_kinds: tuple[tuple[ManualMapping, str], ...] | None = None,
    stop_tokens: frozenset[str] | None = None,
) -> dict[BlockerId, set[str]]:
    """Return visible-data-only keys. Empty values never emit a key."""

    keys: dict[BlockerId, set[str]] = {
        blocker: set() for blocker in config.enabledBlockers
    }
    name_values: list[tuple[str, set[str]]] = []
    location_values: list[str] = []
    address_values: list[str] = []
    prepared_mappings = mapping_kinds or tuple(
        (mapping, _mapping_kind(mapping))
        for mapping in mappings
        if mapping.role == "identity"
    )
    stop = stop_tokens if stop_tokens is not None else frozenset(config.stopTokens)
    for mapping, kind in prepared_mappings:
        if mapping.role != "identity":
            continue
        column = mapping.aColumn if side == "A" else mapping.bColumn
        raw = row.get(column, "")
        if kind == "phone":
            normalized = normalize_phone(raw)
            if normalized and "exact_strong_v1" in keys:
                keys["exact_strong_v1"].add(f"{mapping.mappingId}:phone:{normalized}")
        elif kind == "email":
            normalized = normalize_email(raw)
            if normalized and "exact_strong_v1" in keys:
                keys["exact_strong_v1"].add(f"{mapping.mappingId}:email:{normalized}")
            domain = normalized.rsplit("@", maxsplit=1)[1] if normalized else ""
            if domain and "exact_strong_v1" in keys:
                keys["exact_strong_v1"].add(
                    f"{mapping.mappingId}:email-domain:{domain}"
                )
        elif kind == "domain":
            normalized = normalize_domain(raw)
            if normalized and "exact_strong_v1" in keys:
                keys["exact_strong_v1"].add(f"{mapping.mappingId}:domain:{normalized}")
        elif kind == "name":
            normalized = normalize_name(raw)
            tokens = _meaningful_tokens(raw, stop)
            if normalized:
                name_values.append((normalized, tokens))
        elif kind == "postal":
            normalized = normalize_postal(raw)
            if normalized:
                location_values.append(f"postal:{normalized}")
        elif kind in {"city", "region"}:
            normalized = normalize_text(raw)
            if normalized:
                location_values.append(f"{kind}:{normalized}")
        elif kind == "address":
            normalized = normalize_address(raw)
            if normalized:
                address_values.append(normalized)

    for name, tokens in name_values:
        compact = re_sub_nonword(name)
        if "name_token_v1" in keys:
            keys["name_token_v1"].update(f"token:{token}" for token in tokens)
        if "name_character_v1" in keys:
            if len(compact) >= config.namePrefixLength:
                prefix = compact[: config.namePrefixLength]
                keys["name_character_v1"].add(f"prefix:{prefix}")
            keys["name_character_v1"].update(
                f"token-prefix:{token[: config.namePrefixLength]}"
                for token in tokens
                if len(token) >= config.namePrefixLength
            )
        location_blockers = {
            blocker
            for blocker in ("location_name_v1", "location_name_v2")
            if blocker in keys
        }
        for blocker in location_blockers:
            for location in location_values:
                keys[blocker].update(f"{location}:token:{token}" for token in tokens)
                if blocker == "location_name_v2" and compact:
                    keys[blocker].add(f"{location}:compact-name:{compact}")
        address_blockers = {
            blocker
            for blocker in ("address_name_v1", "address_name_v2")
            if blocker in keys
        }
        for blocker in address_blockers:
            for address in address_values:
                number = address_number(address)
                if number:
                    keys[blocker].update(
                        f"number:{number}:token:{token}" for token in tokens
                    )
                    if blocker == "address_name_v2" and compact:
                        keys[blocker].add(f"number:{number}:compact-name:{compact}")
    return keys


def re_sub_nonword(value: str) -> str:
    return "".join(character for character in value if character.isalnum())


def _inverted_indices(
    rows: list[dict[str, str]],
    side: Literal["A", "B"],
    mappings: list[ManualMapping],
    config: CandidateEngineConfig,
    mapping_kinds: tuple[tuple[ManualMapping, str], ...],
    stop_tokens: frozenset[str],
) -> dict[BlockerId, dict[str, list[int]]]:
    indices: dict[BlockerId, dict[str, list[int]]] = {
        blocker: defaultdict(list) for blocker in config.enabledBlockers
    }
    for index, row in enumerate(rows):
        for blocker, keys in record_blocking_keys(
            row,
            side,
            mappings,
            config,
            mapping_kinds=mapping_kinds,
            stop_tokens=stop_tokens,
        ).items():
            for key in sorted(keys):
                indices[blocker][key].append(index)
    return indices


def _validate_inputs(
    a_headers: list[str],
    b_headers: list[str],
    mappings: list[ManualMapping],
) -> None:
    identity = [mapping for mapping in mappings if mapping.role == "identity"]
    if not identity:
        raise ValueError("At least one identity mapping is required")
    for mapping in identity:
        if mapping.aColumn not in a_headers or mapping.bColumn not in b_headers:
            raise ValueError("A mapping references a column that does not exist")


def generate_candidates(
    a_headers: list[str],
    a_rows: list[dict[str, str]],
    b_headers: list[str],
    b_rows: list[dict[str, str]],
    mappings: list[ManualMapping],
    config: CandidateEngineConfig | None = None,
    *,
    performance_timings: MutableMapping[str, float] | None = None,
) -> CandidateGenerationResult:
    """Generate a union of indexed blocking passes without enumerating A x B."""

    config = config or CandidateEngineConfig()
    _validate_inputs(a_headers, b_headers, mappings)
    a_ids = _row_ids(a_rows, a_headers, "A")
    b_ids = _row_ids(b_rows, b_headers, "B")
    if len(set(a_ids)) != len(a_ids) or len(set(b_ids)) != len(b_ids):
        raise ValueError("Source row IDs must be unique within each dataset")

    mapping_kinds = tuple(
        (mapping, _mapping_kind(mapping))
        for mapping in mappings
        if mapping.role == "identity"
    )
    stop_tokens = frozenset(config.stopTokens)
    index_started = time.perf_counter()
    a_indices = _inverted_indices(
        a_rows, "A", mappings, config, mapping_kinds, stop_tokens
    )
    b_indices = _inverted_indices(
        b_rows, "B", mappings, config, mapping_kinds, stop_tokens
    )
    if performance_timings is not None:
        performance_timings["normalization_index_construction_seconds"] = round(
            time.perf_counter() - index_started, 6
        )

    generation_started = time.perf_counter()
    evidence: dict[tuple[int, int], set[tuple[BlockerId, str]]] = defaultdict(set)
    diagnostics: list[BlockerDiagnostics] = []

    for blocker in config.enabledBlockers:
        common_keys = sorted(set(a_indices[blocker]) & set(b_indices[blocker]))
        keys_used = 0
        relationships_generated = 0
        relationships_suppressed = 0
        suppressed: list[str] = []
        for key in common_keys:
            a_bucket = a_indices[blocker][key]
            b_bucket = b_indices[blocker][key]
            pair_count = len(a_bucket) * len(b_bucket)
            oversized = (
                len(a_bucket) > config.maxBucketSizePerSide
                or len(b_bucket) > config.maxBucketSizePerSide
                or pair_count > config.maxBucketPairCount
            )
            if oversized:
                relationships_suppressed += pair_count
                suppressed.append(_key_hash(key))
                continue
            keys_used += 1
            relationships_generated += pair_count
            hashed = _key_hash(key)
            for a_index in a_bucket:
                for b_index in b_bucket:
                    evidence[(a_index, b_index)].add((blocker, hashed))
        diagnostics.append(
            BlockerDiagnostics(
                blockerId=blocker,
                keysConsidered=len(common_keys),
                keysUsed=keys_used,
                keysSuppressed=len(suppressed),
                relationshipsGenerated=relationships_generated,
                relationshipsSuppressed=relationships_suppressed,
                suppressedKeyHashes=sorted(suppressed),
            )
        )

    candidates = [
        GeneratedCandidate(
            candidateId=_candidate_id(a_ids[a_index], b_ids[b_index]),
            aRowId=a_ids[a_index],
            bRowId=b_ids[b_index],
            blockingEvidence=[
                BlockingEvidence(blockerId=blocker, keyHash=key_hash)
                for blocker, key_hash in sorted(evidence_items)
            ],
        )
        for (a_index, b_index), evidence_items in sorted(evidence.items())
    ]
    seen_a = {candidate.aRowId for candidate in candidates}
    seen_b = {candidate.bRowId for candidate in candidates}
    result = CandidateGenerationResult(
        engineVersion=config.engineVersion,
        normalizationVersion=config.normalizationVersion,
        config=config,
        aRowCount=len(a_rows),
        bRowCount=len(b_rows),
        candidates=candidates,
        zeroCandidateARowIds=sorted(set(a_ids) - seen_a),
        zeroCandidateBRowIds=sorted(set(b_ids) - seen_b),
        blockerDiagnostics=diagnostics,
    )
    if performance_timings is not None:
        performance_timings["candidate_generation_seconds"] = round(
            time.perf_counter() - generation_started, 6
        )
    return result


def candidate_pairs(result: CandidateGenerationResult) -> Iterable[tuple[str, str]]:
    return ((candidate.aRowId, candidate.bRowId) for candidate in result.candidates)
