"""Deterministic cross-domain acceptance suite for semantic evidence behavior."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from samewise_matcher.candidate_engine import CandidateEngineConfig, generate_candidates
from samewise_matcher.explainable_matcher import (
    MatcherConfig,
    build_evidence_plan,
    build_match_result,
    score_generated_candidates,
)
from samewise_matcher.workflow_models import ManualMapping

GENERALIZATION_SUITE_VERSION = "generalization-suite-v1.0.0"


def _mapping(
    mapping_id: str,
    column: str,
    family: str,
    normalizer: str = "text",
) -> ManualMapping:
    return ManualMapping(
        mappingId=mapping_id,
        label=mapping_id.replace("-", " "),
        aColumn=column,
        bColumn=column,
        role="identity",
        normalizer=normalizer,
        semanticFamily=family,
    )


def _domain_fixture(
    domain: str,
) -> tuple[
    list[dict[str, str]],
    list[dict[str, str]],
    list[ManualMapping],
    set[tuple[str, str]],
]:
    rows_a: list[dict[str, str]] = []
    rows_b: list[dict[str, str]] = []
    truth: set[tuple[str, str]] = set()

    if domain == "organizations_vendors":
        headers = [
            "row_id",
            "supplier_number",
            "legal_name",
            "email",
            "phone",
            "address",
        ]
        mappings = [
            _mapping("supplier-number", "supplier_number", "persistent_identifier"),
            _mapping("legal-name", "legal_name", "name_or_title"),
            _mapping("email", "email", "email", "email"),
            _mapping("phone", "phone", "phone", "phone"),
            _mapping("address", "address", "address"),
        ]

        def values(index: int) -> dict[str, str]:
            return {
                "supplier_number": f"SUP-{index:05d}",
                "legal_name": f"Northwind Partner {index}",
                "email": f"ap{index}@vendor{index}.example",
                "phone": f"555100{index:04d}",
                "address": f"{index + 10} Commerce Street",
            }
    elif domain == "people_customers":
        headers = ["row_id", "customer_uuid", "full_name", "email", "phone", "address"]
        mappings = [
            _mapping("customer-uuid", "customer_uuid", "persistent_identifier"),
            _mapping("personal-name", "full_name", "name_or_title"),
            _mapping("email", "email", "email", "email"),
            _mapping("phone", "phone", "phone", "phone"),
            _mapping("address", "address", "address"),
        ]

        def values(index: int) -> dict[str, str]:
            return {
                "customer_uuid": f"9a12-{index:05d}-cafe",
                "full_name": f"Person Given{index} Family{index}",
                "email": f"person{index}@mail{index}.example",
                "phone": f"555200{index:04d}",
                "address": f"{index + 100} Oak Avenue",
            }
    elif domain == "products":
        headers = [
            "row_id",
            "barcode",
            "product_title",
            "brand",
            "model_number",
            "category",
        ]
        mappings = [
            _mapping("barcode", "barcode", "persistent_identifier"),
            _mapping("product-title", "product_title", "name_or_title"),
            _mapping("brand", "brand", "categorical"),
            _mapping("model-number", "model_number", "persistent_identifier"),
            _mapping("category", "category", "categorical"),
        ]

        def values(index: int) -> dict[str, str]:
            return {
                "barcode": f"0123456{index:05d}",
                "product_title": f"Precision Widget Series {index}",
                "brand": f"Brand {index % 9}",
                "model_number": f"MDL-{index:05d}",
                "category": f"Category {index % 5}",
            }
    elif domain == "facilities":
        headers = ["row_id", "site_code", "facility_name", "address", "city", "postal"]
        mappings = [
            _mapping("site-code", "site_code", "persistent_identifier"),
            _mapping("facility-name", "facility_name", "name_or_title"),
            _mapping("address", "address", "address"),
            _mapping("city", "city", "geography"),
            _mapping("postal", "postal", "geography"),
        ]

        def values(index: int) -> dict[str, str]:
            return {
                "site_code": f"SITE-{index:04d}",
                "facility_name": f"Regional Care Center {index}",
                "address": f"{index + 300} Health Road",
                "city": f"Metro {index % 11}",
                "postal": f"{30000 + index:05d}",
            }
    elif domain == "sparse_legacy":
        headers = ["row_id", "legacy_reference", "display_name", "address", "region"]
        mappings = [
            _mapping("legacy-reference", "legacy_reference", "persistent_identifier"),
            _mapping("display-name", "display_name", "name_or_title"),
            _mapping("address", "address", "address"),
            _mapping("region", "region", "geography"),
        ]

        def values(index: int) -> dict[str, str]:
            return {
                "legacy_reference": f"LEG-{index:05d}" if index % 3 == 0 else "",
                "display_name": f"Legacy Workshop {index}",
                "address": f"{index + 500} Foundry Street" if index % 4 else "",
                "region": f"Zone {index % 7}",
            }
    elif domain == "low_information":
        headers = ["row_id", "full_name", "city", "category"]
        mappings = [
            _mapping("display-name", "full_name", "name_or_title"),
            _mapping("city", "city", "geography"),
            _mapping("category", "category", "categorical"),
        ]

        def values(index: int) -> dict[str, str]:
            group = index // 10
            return {
                "full_name": f"Shared Name {group}",
                "city": f"Shared City {group % 2}",
                "category": "standard",
            }
    else:
        raise ValueError(f"Unknown domain {domain}")

    overlap = 30
    for index in range(overlap):
        left = {"row_id": f"A-{domain}-{index:03d}", **values(index)}
        right = {"row_id": f"B-{domain}-{index:03d}", **values(index)}
        if domain != "low_information":
            if index % 7 == 0:
                identifiers = [
                    mapping
                    for mapping in mappings
                    if mapping.semanticFamily == "persistent_identifier"
                ]
                for mapping in identifiers[:1] if domain == "products" else identifiers:
                    left[mapping.aColumn] = ""
                    right[mapping.bColumn] = ""
                title = next(
                    (
                        item
                        for item in mappings
                        if item.semanticFamily == "name_or_title"
                    ),
                    None,
                )
                if title:
                    right[title.bColumn] = right[title.bColumn].replace(" ", "", 1)
            if index % 11 == 0:
                phone = next(
                    (item for item in mappings if item.semanticFamily == "phone"), None
                )
                if phone:
                    right[phone.bColumn] = f"999{index:07d}"
        rows_a.append(left)
        rows_b.append(right)
        truth.add((left["row_id"], right["row_id"]))

    for offset in range(5):
        index = overlap + offset
        rows_a.append({"row_id": f"A-{domain}-only-{offset:03d}", **values(index)})
        other = index + 100
        rows_b.append({"row_id": f"B-{domain}-only-{offset:03d}", **values(other)})
    assert list(rows_a[0]) == headers
    return rows_a, rows_b, mappings, truth


def _evaluate_domain(domain: str) -> dict[str, Any]:
    rows_a, rows_b, mappings, truth = _domain_fixture(domain)
    headers_a = list(rows_a[0])
    headers_b = list(rows_b[0])
    candidate_config = CandidateEngineConfig()
    matcher_config = MatcherConfig()
    generated = generate_candidates(
        headers_a, rows_a, headers_b, rows_b, mappings, candidate_config
    )
    a_by_id = {row[headers_a[0]]: row for row in rows_a}
    b_by_id = {row[headers_b[0]]: row for row in rows_b}
    scored = score_generated_candidates(
        generated.candidates, a_by_id, b_by_id, mappings, matcher_config
    )
    result = build_match_result(
        headers_a,
        rows_a,
        headers_b,
        rows_b,
        scored,
        matcher_config,
        build_evidence_plan(a_by_id, b_by_id, mappings),
    )
    generated_pairs = {(item.aRowId, item.bRowId) for item in generated.candidates}
    top_by_a: dict[str, Any] = {}
    for candidate in result.candidates:
        if candidate.rank == 1:
            top_by_a[candidate.aRowId] = candidate
    auto = [item for item in top_by_a.values() if item.band == "auto_match"]
    review = [item for item in top_by_a.values() if item.band == "needs_review"]
    true_auto = sum((item.aRowId, item.bRowId) in truth for item in auto)
    true_review = sum((item.aRowId, item.bRowId) in truth for item in review)
    truth_by_a: dict[str, set[str]] = defaultdict(set)
    for a_id, b_id in truth:
        truth_by_a[a_id].add(b_id)
    false_negative = sum(a_id not in top_by_a for a_id in truth_by_a)
    theoretical = len(rows_a) * len(rows_b)
    return {
        "fixture": domain,
        "rowCountA": len(rows_a),
        "rowCountB": len(rows_b),
        "theoreticalPairs": theoretical,
        "candidatePairs": len(generated.candidates),
        "candidateReduction": round(1 - len(generated.candidates) / theoretical, 9),
        "candidateRecall": round(len(generated_pairs & truth) / len(truth), 9),
        "autoMatchCount": len(auto),
        "autoMatchPrecision": round(true_auto / len(auto), 9) if auto else None,
        "recall": round((true_auto + true_review) / len(truth_by_a), 9),
        "falsePositives": len(auto) - true_auto,
        "falseNegatives": false_negative,
        "reviewCount": len(review),
        "reviewRate": round(len(review) / len(rows_a), 9),
        "reviewYield": round(true_review / len(review), 9) if review else None,
        "collisionCount": sum(item.collision for item in review),
        "unmatchedA": len(result.onlyA),
        "weakEvidenceAbstention": domain == "low_information" and len(auto) == 0,
    }


def run_generalization_suite() -> dict[str, Any]:
    domains = [
        "organizations_vendors",
        "people_customers",
        "products",
        "facilities",
        "sparse_legacy",
        "low_information",
    ]
    results = [_evaluate_domain(domain) for domain in domains]
    gates = {
        "noFalseAutomaticMatches": all(item["falsePositives"] == 0 for item in results),
        "candidateRecallPreserved": all(
            item["candidateRecall"] >= 0.95
            for item in results
            if item["fixture"] != "low_information"
        ),
        "lowInformationAbstains": next(
            item for item in results if item["fixture"] == "low_information"
        )["weakEvidenceAbstention"],
    }
    return {
        "suiteVersion": GENERALIZATION_SUITE_VERSION,
        "matcherVersion": MatcherConfig().matcherVersion,
        "featurePipelineVersion": MatcherConfig().featurePipelineVersion,
        "candidateEngineVersion": CandidateEngineConfig().engineVersion,
        "thresholdChanges": "none",
        "results": results,
        "gates": gates,
        "passed": all(gates.values()),
    }


def markdown_generalization_suite(report: dict[str, Any]) -> str:
    lines = [
        "# Multi-domain generalization suite",
        "",
        f"Suite: `{report['suiteVersion']}`  ",
        f"Matcher: `{report['matcherVersion']}`  ",
        f"Candidate engine: `{report['candidateEngineVersion']}`  ",
        f"Threshold changes: **{report['thresholdChanges']}**",
        "",
        "| Fixture | Candidate recall | Reduction | Auto precision | Recall | "
        "False auto | Review rate | Review yield | Collisions |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for item in report["results"]:
        auto_precision = (
            "n/a"
            if item["autoMatchPrecision"] is None
            else f"{item['autoMatchPrecision']:.3%}"
        )
        review_yield = (
            "n/a" if item["reviewYield"] is None else f"{item['reviewYield']:.3%}"
        )
        lines.append(
            f"| {item['fixture']} | {item['candidateRecall']:.3%} | "
            f"{item['candidateReduction']:.3%} | {auto_precision} | "
            f"{item['recall']:.3%} | {item['falsePositives']} | "
            f"{item['reviewRate']:.3%} | {review_yield} | "
            f"{item['collisionCount']} |"
        )
    lines.extend(
        [
            "",
            "Low-information success means abstention, not matching everything.",
            f"Overall gate: **{'PASS' if report['passed'] else 'FAIL'}**",
            "",
        ]
    )
    return "\n".join(lines)


def write_generalization_artifacts(report: dict[str, Any], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (output_dir / "summary.md").write_text(
        markdown_generalization_suite(report), encoding="utf-8"
    )
