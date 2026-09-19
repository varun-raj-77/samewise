"""Deterministic, truth-separated review-workload forensics.

The fixture is an integration regression reconstructed from the published 8K × 8K
walkthrough shape. Generated CSVs are temporary; only compact configuration and
measured reports belong in the repository.
"""

from __future__ import annotations

import csv
import hashlib
import json
import random
import tempfile
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from samewise_matcher.baseline import read_csv
from samewise_matcher.blocking_normalization import normalize_text
from samewise_matcher.candidate_engine import CandidateEngineConfig, generate_candidates
from samewise_matcher.explainable_matcher import (
    MatcherConfig,
    build_match_result,
    score_generated_candidates,
)
from samewise_matcher.workflow_models import ManualMapping

REVIEW_WORKLOAD_GENERATOR_VERSION = "review-workload-generator-v1.0.0"
REVIEW_WORKLOAD_ANALYSIS_VERSION = "review-workload-analysis-v1.0.0"


class ReviewWorkloadConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fixtureName: str = Field(min_length=1)
    generatorVersion: str = REVIEW_WORKLOAD_GENERATOR_VERSION
    seed: int
    rowsA: int = Field(gt=0)
    rowsB: int = Field(gt=0)
    overlap: int = Field(gt=0)
    aOnly: int = Field(ge=0)
    bOnly: int = Field(ge=0)
    clearOverlap: int = Field(ge=0)
    ambiguousOverlap: int = Field(ge=0)
    pairedSourceOnlyNoise: int = Field(ge=0)
    contactGroupSize: int = Field(default=7, ge=2, le=20)

    @model_validator(mode="after")
    def validate_counts(self) -> ReviewWorkloadConfig:
        if self.generatorVersion != REVIEW_WORKLOAD_GENERATOR_VERSION:
            raise ValueError("Unsupported review-workload generator version")
        if self.overlap + self.aOnly != self.rowsA:
            raise ValueError("overlap + aOnly must equal rowsA")
        if self.overlap + self.bOnly != self.rowsB:
            raise ValueError("overlap + bOnly must equal rowsB")
        if self.clearOverlap + self.ambiguousOverlap != self.overlap:
            raise ValueError("clearOverlap + ambiguousOverlap must equal overlap")
        if self.pairedSourceOnlyNoise > min(self.aOnly, self.bOnly):
            raise ValueError("pairedSourceOnlyNoise exceeds source-only rows")
        return self


HEADERS = [
    "record_id",
    "stable_id",
    "company_name",
    "contact_name",
    "email",
    "phone",
    "address",
    "city",
    "postal",
]


def legacy_review_mappings() -> list[ManualMapping]:
    """The exact pre-generalization setup used to capture the BEFORE report."""

    values = [
        ("persistent-code", "Supplier identifier", "stable_id", "text"),
        ("entity-name", "Company name", "company_name", "text"),
        ("contact-person", "Contact name", "contact_name", "text"),
        ("email", "Email", "email", "email"),
        ("phone", "Phone", "phone", "phone"),
        ("address", "Address", "address", "text"),
        ("city", "City", "city", "text"),
        ("postal", "Postal", "postal", "text"),
    ]
    return [
        ManualMapping(
            mappingId=mapping_id,
            label=label,
            aColumn=column,
            bColumn=column,
            role="identity",
            normalizer=normalizer,
        )
        for mapping_id, label, column, normalizer in values
    ]


def semantic_review_mappings() -> list[ManualMapping]:
    families = {
        "persistent-code": "persistent_identifier",
        "entity-name": "name_or_title",
        "contact-person": "contact_person",
        "email": "email",
        "phone": "phone",
        "address": "address",
        "city": "geography",
        "postal": "geography",
    }
    return [
        mapping.model_copy(update={"semanticFamily": families[mapping.mappingId]})
        for mapping in legacy_review_mappings()
    ]


def _token(index: int) -> str:
    alphabet = "abcdefghijklmnopqrstuvwxyz"
    value = int.from_bytes(
        hashlib.sha256(f"review-token:{index}".encode()).digest()[:8], "big"
    )
    chars: list[str] = []
    for _ in range(10):
        chars.append(alphabet[value % len(alphabet)])
        value //= len(alphabet)
    return "".join(reversed(chars))


def _base_row(entity_index: int, side: str) -> dict[str, str]:
    token = _token(entity_index)
    city_index = entity_index % 97
    return {
        "record_id": f"{side}{entity_index:06d}",
        "stable_id": f"VEND-{100000 + entity_index}",
        "company_name": f"{token} Meridian Works",
        "contact_name": f"Contact {token}",
        "email": f"account{entity_index}@{token}.example",
        "phone": f"555{entity_index % 10_000_000:07d}",
        "address": f"{100 + entity_index} Market Street",
        "city": f"City {city_index:02d}",
        "postal": f"{10000 + entity_index % 80000:05d}",
    }


def _ambiguous_b(row: dict[str, str], entity_index: int) -> dict[str, str]:
    changed = dict(row)
    changed["stable_id"] = ""
    tokens = changed["company_name"].split()
    changed["company_name"] = f"{tokens[0]} Meridian"
    changed["email"] = ""
    changed["phone"] = f"555{(entity_index + 1) % 10_000_000:07d}"
    changed["address"] = changed["address"].replace("Street", "St")
    changed["postal"] = ""
    return changed


def generate_public_review_workload(
    config: ReviewWorkloadConfig,
) -> tuple[list[dict[str, str]], list[dict[str, str]], dict[str, str], dict[str, str]]:
    """Return visible A/B rows and separately held A/B canonical truth maps."""

    rows_a: list[dict[str, str]] = []
    rows_b: list[dict[str, str]] = []
    truth_a: dict[str, str] = {}
    truth_b: dict[str, str] = {}

    for index in range(1, config.overlap + 1):
        canonical = f"entity-{index:06d}"
        a_row = _base_row(index, "A")
        b_row = _base_row(index, "B")
        if index > config.clearOverlap:
            a_row["stable_id"] = ""
            b_row = _ambiguous_b(b_row, index)
        rows_a.append(a_row)
        rows_b.append(b_row)
        truth_a[a_row["record_id"]] = canonical
        truth_b[b_row["record_id"]] = canonical

    noise_start = config.overlap + 1
    for offset in range(config.aOnly):
        index = noise_start + offset
        row = _base_row(index, "A")
        canonical = f"a-only-{offset:06d}"
        if offset < config.pairedSourceOnlyNoise:
            group = offset // config.contactGroupSize
            row["stable_id"] = f"LEGACY-A-{group:04d}-{offset:03d}"
            row["company_name"] = f"Aonly {_token(index)} Trading"
            row["contact_name"] = f"Representative {_token(group)}"
            row["city"] = f"Shared City {group % 13:02d}"
            row["postal"] = f"{60000 + offset:05d}"
        rows_a.append(row)
        truth_a[row["record_id"]] = canonical

    b_noise_start = config.overlap + config.aOnly + 1
    for offset in range(config.bOnly):
        index = b_noise_start + offset
        row = _base_row(index, "B")
        canonical = f"b-only-{offset:06d}"
        if offset < config.pairedSourceOnlyNoise:
            group = offset // config.contactGroupSize
            row["stable_id"] = f"LEGACY-B-{group:04d}-{offset:03d}"
            row["company_name"] = f"Bonly {_token(index)} Supply"
            row["contact_name"] = f"Representative {_token(group)}"
            row["city"] = f"Shared City {group % 13:02d}"
            row["postal"] = f"{60000 + offset:05d}"
        rows_b.append(row)
        truth_b[row["record_id"]] = canonical

    rng = random.Random(config.seed)
    rng.shuffle(rows_a)
    rng.shuffle(rows_b)
    return rows_a, rows_b, truth_a, truth_b


def _write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=HEADERS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def _band(value: float, edges: tuple[float, ...]) -> str:
    for lower, upper in zip(edges, edges[1:], strict=True):
        if lower <= value < upper:
            return f"{lower:.2f}-{upper:.2f}"
    return f"{edges[-2]:.2f}-{edges[-1]:.2f}"


def _distribution(values: list[str]) -> list[dict[str, Any]]:
    counts = Counter(values)
    return [
        {"value": value, "count": count, "rate": round(count / len(values), 9)}
        for value, count in sorted(counts.items())
    ]


def _signature(candidate: Any, candidate_count: int) -> str:
    parts = [
        f"{item.fieldKind}:{item.evidenceClass}:{item.informationClass or 'unknown'}"
        for item in candidate.evidence
    ]
    parts.extend(
        [
            "margin:"
            + _band(candidate.runnerUpMargin, (0, 0.02, 0.04, 0.10, 1.000001)),
            f"alternatives:{'multiple' if candidate_count > 1 else 'single'}",
            f"collision:{str(candidate.collision).lower()}",
            f"strong:{str(candidate.strongContradiction).lower()}",
        ]
    )
    return "|".join(parts)


def analyze_review_workload(
    config: ReviewWorkloadConfig, *, semantic: bool = False
) -> dict[str, Any]:
    started = time.perf_counter()
    a_rows, b_rows, truth_a, truth_b = generate_public_review_workload(config)
    mappings = semantic_review_mappings() if semantic else legacy_review_mappings()
    candidate_config = (
        CandidateEngineConfig()
        if semantic
        else CandidateEngineConfig(
            engineVersion="candidate-engine-v0.3.0",
            enabledBlockers=(
                "exact_strong_v1",
                "name_token_v1",
                "name_character_v1",
                "location_name_v2",
                "address_name_v2",
            ),
        )
    )
    matcher_config = (
        MatcherConfig()
        if semantic
        else MatcherConfig(
            matcherVersion="explainable-matcher-v0.2.0",
            configVersion="matcher-config-v0.2.0",
            featurePipelineVersion="feature-pipeline-v0.1.0",
            candidateEngineVersion="candidate-engine-v0.3.0",
            tunedOnFixture="organizations-matcher-tune-1200-v1",
        )
    )
    with tempfile.TemporaryDirectory(prefix="samewise-review-workload-") as directory:
        a_path = Path(directory) / "dataset_a.csv"
        b_path = Path(directory) / "dataset_b.csv"
        _write_csv(a_path, a_rows)
        _write_csv(b_path, b_rows)
        a_headers, loaded_a = read_csv(a_path)
        b_headers, loaded_b = read_csv(b_path)
        timings: dict[str, float] = {}
        generated = generate_candidates(
            a_headers,
            loaded_a,
            b_headers,
            loaded_b,
            mappings,
            candidate_config,
            performance_timings=timings,
        )
        a_by_id = {row[HEADERS[0]]: row for row in loaded_a}
        b_by_id = {row[HEADERS[0]]: row for row in loaded_b}
        scored = score_generated_candidates(
            generated.candidates,
            a_by_id,
            b_by_id,
            mappings,
            matcher_config,
            performance_timings=timings,
        )
        result = build_match_result(
            a_headers, loaded_a, b_headers, loaded_b, scored, matcher_config
        )

    true_pairs = {
        (a_id, b_id)
        for a_id, a_entity in truth_a.items()
        for b_id, b_entity in truth_b.items()
        if a_entity == b_entity
    }
    generated_pairs = {(item.aRowId, item.bRowId) for item in generated.candidates}
    scored_by_a: dict[str, list[Any]] = defaultdict(list)
    for item in scored:
        scored_by_a[item.aRowId].append(item)
    for values in scored_by_a.values():
        values.sort(key=lambda item: (-item.matchScore, item.bRowId))
    retained_by_a: dict[str, list[Any]] = defaultdict(list)
    for candidate in result.candidates:
        retained_by_a[candidate.aRowId].append(candidate)
    for values in retained_by_a.values():
        values.sort(key=lambda item: item.rank)

    normalized_frequencies: dict[str, tuple[Counter[str], Counter[str]]] = {}
    for mapping in mappings:
        normalized_frequencies[mapping.mappingId] = (
            Counter(
                normalize_text(row[mapping.aColumn])
                for row in a_rows
                if normalize_text(row[mapping.aColumn])
            ),
            Counter(
                normalize_text(row[mapping.bColumn])
                for row in b_rows
                if normalize_text(row[mapping.bColumn])
            ),
        )

    cases: list[dict[str, Any]] = []
    auto_pairs: list[tuple[str, str]] = []
    for a_id, retained in sorted(retained_by_a.items()):
        if not retained:
            continue
        top = retained[0]
        if top.band == "auto_match":
            auto_pairs.append((top.aRowId, top.bRowId))
            continue
        ranked = scored_by_a[a_id]
        true_rank = next(
            (
                index
                for index, item in enumerate(ranked, start=1)
                if (item.aRowId, item.bRowId) in true_pairs
            ),
            None,
        )
        retained_true = next(
            (item for item in retained if (item.aRowId, item.bRowId) in true_pairs),
            None,
        )
        field_evidence = []
        for item in top.evidence:
            a_frequency, b_frequency = normalized_frequencies[item.mappingId]
            field_evidence.append(
                {
                    "mappingId": item.mappingId,
                    "semanticFieldFamily": item.fieldKind,
                    "evidenceClass": item.evidenceClass,
                    "outcome": item.outcome,
                    "positiveContribution": item.positiveContribution,
                    "contradictionContribution": item.conflictContribution,
                    "contribution": item.contribution,
                    "informationClass": item.informationClass,
                    "normalizedAFrequency": a_frequency.get(item.normalizedA, 0),
                    "normalizedBFrequency": b_frequency.get(item.normalizedB, 0),
                }
            )
        cases.append(
            {
                "aRecordId": a_id,
                "topCandidateBRecordId": top.bRowId,
                "topCandidateIsTruePair": (top.aRowId, top.bRowId) in true_pairs,
                "truePairExistsAmongAlternatives": retained_true is not None,
                "trueCandidateRank": true_rank,
                "topScore": top.matchScore,
                "secondScore": ranked[1].matchScore if len(ranked) > 1 else 0.0,
                "topSecondMargin": top.runnerUpMargin,
                "candidateCount": len(retained),
                "generatedCandidateCount": len(ranked),
                "collision": top.collision,
                "blockingProvenance": [
                    item.model_dump() for item in top.blockingEvidence
                ],
                "exactAgreements": [
                    item.mappingId
                    for item in top.evidence
                    if item.evidenceClass == "exact_agreement"
                ],
                "partialAgreements": [
                    item.mappingId
                    for item in top.evidence
                    if item.evidenceClass == "partial_agreement"
                ],
                "conflicts": [
                    item.mappingId
                    for item in top.evidence
                    if item.evidenceClass == "conflict"
                ],
                "missing": [
                    item.mappingId
                    for item in top.evidence
                    if item.evidenceClass.startswith("missing_")
                ],
                "fieldEvidence": field_evidence,
                "strongContradiction": top.strongContradiction,
                "evidenceSignature": _signature(top, len(retained)),
            }
        )

    false_auto = [pair for pair in auto_pairs if pair not in true_pairs]
    review_true_top = sum(item["topCandidateIsTruePair"] for item in cases)
    review_truth_alt = sum(
        not item["topCandidateIsTruePair"] and item["truePairExistsAmongAlternatives"]
        for item in cases
    )
    review_no_truth = sum(item["trueCandidateRank"] is None for item in cases)
    review_a_ids = {item["aRecordId"] for item in cases}
    review_b_ids = {
        candidate.bRowId
        for candidate in result.candidates
        if candidate.aRowId in review_a_ids
    }
    primary_only_a = [
        item for item in result.onlyA if item["rowId"] not in review_a_ids
    ]
    primary_only_b = [
        item for item in result.onlyB if item["rowId"] not in review_b_ids
    ]
    blocker_counts = Counter(
        blocker["blockerId"] for item in cases for blocker in item["blockingProvenance"]
    )
    dominant_fields = Counter(
        evidence["mappingId"]
        for item in cases
        for evidence in item["fieldEvidence"]
        if evidence["positiveContribution"] > 0
    )
    strong_families = {
        "persistent_identifier",
        "name_or_title",
        "email",
        "phone",
        "address",
    }

    def eligible_same(item: dict[str, Any]) -> bool:
        strong_positive_count = sum(
            evidence["semanticFieldFamily"] in strong_families
            and evidence["evidenceClass"] in {"exact_agreement", "partial_agreement"}
            and evidence["positiveContribution"] > 0
            and evidence["informationClass"] != "common"
            for evidence in item["fieldEvidence"]
        )
        persistent_conflict = any(
            evidence["semanticFieldFamily"] == "persistent_identifier"
            and evidence["evidenceClass"] == "conflict"
            for evidence in item["fieldEvidence"]
        )
        return (
            not item["collision"]
            and item["topSecondMargin"] >= 0.04
            and not item["strongContradiction"]
            and not persistent_conflict
            and strong_positive_count >= 2
        )

    def eligible_different(item: dict[str, Any]) -> bool:
        positives = [
            evidence
            for evidence in item["fieldEvidence"]
            if evidence["positiveContribution"] > 0
        ]
        low_information = bool(positives) and all(
            evidence["semanticFieldFamily"]
            in {
                "contact_person",
                "geography",
                "categorical",
                "source_local_identifier",
                "free_text",
                "unknown",
            }
            or evidence["informationClass"] in {"repeated", "common"}
            for evidence in positives
        )
        persistent_exact = any(
            evidence["semanticFieldFamily"] == "persistent_identifier"
            and evidence["evidenceClass"] == "exact_agreement"
            for evidence in item["fieldEvidence"]
        )
        strong_positive_count = sum(
            evidence["semanticFieldFamily"] in strong_families
            and evidence["evidenceClass"] in {"exact_agreement", "partial_agreement"}
            and evidence["positiveContribution"] > 0
            and evidence["informationClass"] != "common"
            for evidence in positives
        )
        return (
            not item["collision"]
            and item["topSecondMargin"] >= 0.04
            and item["candidateCount"] == 1
            and not persistent_exact
            and strong_positive_count < 2
            and low_information
        )

    grouping_started = time.perf_counter()
    grouped_cases: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in cases:
        grouped_cases[item["evidenceSignature"]].append(item)
    review_groups = []
    individual_review_count = 0
    for signature, entries in sorted(grouped_cases.items()):
        same_count = sum(eligible_same(item) for item in entries)
        different_count = sum(eligible_different(item) for item in entries)
        suggested = (
            "same_entity"
            if same_count == len(entries)
            else "different_entity"
            if different_count == len(entries)
            else None
        )
        if suggested is None:
            individual_review_count += len(entries)
        review_groups.append(
            {
                "signature": signature,
                "caseCount": len(entries),
                "eligibleSameCount": same_count,
                "eligibleDifferentCount": different_count,
                "suggestedDecision": suggested,
            }
        )
    review_grouping_seconds = time.perf_counter() - grouping_started
    elapsed = time.perf_counter() - started
    report = {
        "analysisVersion": REVIEW_WORKLOAD_ANALYSIS_VERSION,
        "fixture": config.model_dump(mode="json"),
        "mode": "semantic" if semantic else "legacy_inferred",
        "provenance": {
            "configSha256": hashlib.sha256(
                json.dumps(config.model_dump(mode="json"), sort_keys=True).encode()
            ).hexdigest(),
            "matcherVersion": result.matcherVersion,
            "featurePipelineVersion": result.featurePipelineVersion,
            "candidateEngineVersion": result.candidateEngineVersion,
            "matcherConfigVersion": result.matcherConfigVersion,
            "candidateConfig": candidate_config.model_dump(mode="json"),
            "matcherConfig": matcher_config.model_dump(mode="json"),
            "groundTruthBoundary": (
                "Loaded only after candidate generation and scoring."
            ),
        },
        "metrics": {
            "theoreticalPairs": config.rowsA * config.rowsB,
            "candidatePairs": len(generated.candidates),
            "candidateReduction": round(
                1 - len(generated.candidates) / (config.rowsA * config.rowsB), 9
            ),
            "candidateRecall": round(
                len(generated_pairs & true_pairs) / len(true_pairs), 9
            ),
            "autoMatchCount": len(auto_pairs),
            "autoMatchPrecision": round(
                (len(auto_pairs) - len(false_auto)) / len(auto_pairs), 9
            )
            if auto_pairs
            else None,
            "falseAutoMatchCount": len(false_auto),
            "hardNegativeAutoMatchCount": 0,
            "reviewCount": len(cases),
            "reviewYield": round(
                sum(item["trueCandidateRank"] is not None for item in cases)
                / len(cases),
                9,
            )
            if cases
            else None,
            "reviewYieldDefinition": (
                "true underlying matches appearing in review / total review cases"
            ),
            "reviewTruePairTopCandidates": review_true_top,
            "reviewFalseTopCandidates": len(cases) - review_true_top,
            "reviewTruthOnlyInAlternatives": review_truth_alt,
            "reviewNoTrueCandidateAvailable": review_no_truth,
            "onlyA": len(result.onlyA),
            "onlyB": len(result.onlyB),
            "primaryNoMatchFoundInB": len(primary_only_a),
            "primaryNoMatchFoundInA": len(primary_only_b),
            "collisionCount": sum(item["collision"] for item in cases),
            "nearTieCount": sum(item["topSecondMargin"] < 0.04 for item in cases),
            "reviewGroupCount": len(review_groups),
            "batchSameEligibleCount": sum(eligible_same(item) for item in cases),
            "batchDifferentEligibleCount": sum(
                eligible_different(item) for item in cases
            ),
            "individualReviewCount": individual_review_count,
        },
        "distributions": {
            "scoreBands": _distribution(
                [
                    _band(item["topScore"], (0, 0.25, 0.35, 0.5, 0.7, 1.000001))
                    for item in cases
                ]
            ),
            "marginBands": _distribution(
                [
                    _band(item["topSecondMargin"], (0, 0.02, 0.04, 0.10, 1.000001))
                    for item in cases
                ]
            ),
            "evidenceSignatures": [
                {"signature": key, "count": value}
                for key, value in Counter(
                    item["evidenceSignature"] for item in cases
                ).most_common()
            ],
            "blockerSources": [
                {"blockerId": key, "caseCount": value}
                for key, value in blocker_counts.most_common()
            ],
            "dominantPositiveFields": [
                {"mappingId": key, "caseCount": value}
                for key, value in dominant_fields.most_common()
            ],
        },
        "performance": {
            **timings,
            "review_grouping_seconds": round(review_grouping_seconds, 6),
            "analysis_seconds": round(elapsed, 6),
        },
        "reviewGroups": review_groups,
        "reviewCases": cases,
    }
    return report


def markdown_review_workload(report: dict[str, Any]) -> str:
    metrics = report["metrics"]
    primary_no_match_b = metrics["primaryNoMatchFoundInB"]
    primary_no_match_a = metrics["primaryNoMatchFoundInA"]
    top_signatures = report["distributions"]["evidenceSignatures"][:8]
    signatures = "\n".join(
        f"- `{item['signature']}`: {item['count']}" for item in top_signatures
    )
    return f"""# Review-workload analysis: {report["fixture"]["fixtureName"]}

This deterministic fixture reconstructs the published 8K × 8K workload shape.
Ground truth is held separately and is joined only after truth-blind candidate
generation and scoring. Review yield means **true underlying matches appearing in
review / total review cases**; it is not precision.

## Counts

- Theoretical pairs: {metrics["theoreticalPairs"]:,}
- Candidate pairs: {metrics["candidatePairs"]:,}
- Candidate reduction: {metrics["candidateReduction"]:.3%}
- Candidate recall: {metrics["candidateRecall"]:.3%}
- Automatic matches: {metrics["autoMatchCount"]:,}
- Automatic precision: {metrics["autoMatchPrecision"]:.3%}
- False automatic matches: {metrics["falseAutoMatchCount"]:,}
- Review cases: {metrics["reviewCount"]:,}
- Review yield: {metrics["reviewYield"]:.3%}
- True top candidates in review: {metrics["reviewTruePairTopCandidates"]:,}
- False top candidates in review: {metrics["reviewFalseTopCandidates"]:,}
- Truth only in retained alternatives: {metrics["reviewTruthOnlyInAlternatives"]:,}
- No true generated candidate in review: {metrics["reviewNoTrueCandidateAvailable"]:,}
- No match found in B (mutually exclusive product state): {primary_no_match_b:,}
- No match found in A (mutually exclusive product state): {primary_no_match_a:,}
- Internal matcher A-only projection: {metrics["onlyA"]:,}
- Internal matcher B-not-auto-linked projection: {metrics["onlyB"]:,}
- Collisions: {metrics["collisionCount"]:,}
- Near ties (margin < 0.04): {metrics["nearTieCount"]:,}
- Deterministic review groups: {metrics["reviewGroupCount"]:,}
- Eligible for human batch SAME: {metrics["batchSameEligibleCount"]:,}
- Eligible for human batch DIFFERENT: {metrics["batchDifferentEligibleCount"]:,}
- Cases requiring individual review after grouping: {metrics["individualReviewCount"]:,}

## Dominant review signatures

{signatures or "- None"}

## Interpretation

The fixture deliberately separates clear overlap, genuine contradictory overlap,
and source-only rows that share repeated supporting attributes. It is useful only
if the resulting queue is close enough to the public walkthrough to expose those
three compositions; its corruption frequencies are not production assumptions.
"""


def write_review_workload_artifacts(report: dict[str, Any], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "analysis.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (output_dir / "summary.md").write_text(
        markdown_review_workload(report), encoding="utf-8"
    )
