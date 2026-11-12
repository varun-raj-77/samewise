"""Independent hand-crafted adversarial cases for the SW-052 address probe.

Unlike SW-052's repeated synthetic pattern, these cases enumerate distinct
entity histories and source-only identities. Labels remain outside source rows
until the two unchanged matcher paths finish scoring and assigning bands.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from samewise_matcher.address_location_probe import (
    generate_address_location_candidates,
)
from samewise_matcher.candidate_engine import CandidateEngineConfig, generate_candidates
from samewise_matcher.explainable_matcher import (
    MatcherConfig,
    build_match_result,
    score_candidate,
    score_generated_candidates,
)
from samewise_matcher.workflow_models import BlockingEvidenceView, ManualMapping

ADVERSARIAL_VERSION = "sw-054-independent-address-adversarial-v0.1.0"
A_HEADERS = ["id", "organization", "street", "city", "state"]
B_HEADERS = ["id", "company", "address", "locality", "region"]


@dataclass(frozen=True)
class LabeledRecord:
    row_id: str
    entity: str
    name: str
    street: str
    city: str
    state: str = "OH"


@dataclass(frozen=True)
class Scenario:
    key: str
    description: str
    a: tuple[LabeledRecord, ...]
    b: tuple[LabeledRecord, ...]
    include_region: bool = False


def adversarial_scenarios() -> tuple[Scenario, ...]:
    """Deliberately not derived from SW-052's generator or corruption patterns."""

    return (
        Scenario(
            "unrelated_tenant_false_auto",
            "Different businesses with similar names occupy the same premises",
            (LabeledRecord("A1", "entity-alpha", "Alpha Analytics",
                           "401 Beacon Street", "Akron"),),
            (LabeledRecord("B1", "entity-aloha", "Aloha Facilities",
                           "401 Beacon St", "AKRON"),),
        ),
        Scenario(
            "renamed_same_site",
            "The same organization rebrands without moving",
            (LabeledRecord("A1", "entity-copper", "Copperline Logistics",
                           "77 River Road", "Toledo"),),
            (LabeledRecord("B1", "entity-copper", "Moonwave Supply",
                           "77 River Rd", "TOLEDO"),),
        ),
        Scenario(
            "same_name_unrelated",
            "Two distinct legal entities share name, street, and locality",
            (LabeledRecord("A1", "entity-north-1", "Summit Diagnostics",
                           "300 Oak Street", "Canton"),),
            (LabeledRecord("B1", "entity-north-2", "Summit Diagnostics",
                           "300 Oak St", "Canton"),),
        ),
        Scenario(
            "shared_building_two_rebrands",
            "Two different occupants both rename at the same shared address",
            (
                LabeledRecord("A1", "tenant-a", "Cobalt Finance",
                              "28 Birch Street", "Dayton"),
                LabeledRecord("A2", "tenant-b", "Copper Dental",
                              "28 Birch Street", "Dayton"),
            ),
            (
                LabeledRecord("B1", "tenant-a", "Meridian Capital",
                              "28 Birch St", "DAYTON"),
                LabeledRecord("B2", "tenant-b", "Silverleaf Dentistry",
                              "28 Birch St", "DAYTON"),
            ),
        ),
        Scenario(
            "relocated_same_entity",
            "An organization moves to a new site without a name change",
            (LabeledRecord("A1", "clinic-one", "Lakeshore Pediatrics",
                           "911 Pine Street", "Elyria"),),
            (LabeledRecord("B1", "clinic-one", "Lakeshore Pediatrics",
                           "15 Maple Road", "Elyria"),),
        ),
        Scenario(
            "previous_tenant_successor",
            "An unrelated new tenant replaces the old site's occupant",
            (LabeledRecord("A1", "old-tenant", "Harbor Consulting",
                           "818 Main Street", "Medina"),),
            (LabeledRecord("B1", "new-tenant", "Horizon Contractors",
                           "818 Main St", "MEDINA"),),
        ),
        Scenario(
            "address_without_locality",
            "Matching address with missing locality is not enough to form the key",
            (LabeledRecord("A1", "firm-one", "Tern Fieldwork",
                           "600 Cherry Road", "Lima"),),
            (LabeledRecord("B1", "firm-one", "Citrine Operators",
                           "600 Cherry Rd", ""),),
        ),
        Scenario(
            "different_cities",
            "Identical street text in different cities should not collide",
            (LabeledRecord("A1", "firm-a", "Canopy Labs",
                           "50 Market Street", "Cleveland"),),
            (LabeledRecord("B1", "firm-b", "Cannon Logistics",
                           "50 Market St", "Columbus"),),
        ),
        Scenario(
            "different_street_same_number",
            "The same street number on different roads is not the same address",
            (LabeledRecord("A1", "site-a", "Elm Analytics",
                           "25 Maple Road", "Athens"),),
            (LabeledRecord("B1", "site-b", "Orchard Services",
                           "25 Pine Road", "Athens"),),
        ),
        Scenario(
            "same_city_different_state",
            "Equal city and address, but confirmed regions disagree",
            (LabeledRecord("A1", "firm-oh", "Alpha Analytics",
                           "401 Beacon Street", "Springfield", "OH"),),
            (LabeledRecord("B1", "firm-il", "Aloha Facilities",
                           "401 Beacon St", "Springfield", "IL"),),
            include_region=True,
        ),
        Scenario(
            "shared_address_b_with_no_counterpart",
            "An unrelated tenant exists where A has no matching B record",
            (LabeledRecord("A1", "only-in-a", "Velocity Transport",
                           "12 Elm Avenue", "Hamilton"),),
            (LabeledRecord("B1", "only-in-b", "Veracity Trading",
                           "12 Elm Ave", "Hamilton"),),
        ),
        Scenario(
            "name_collision_only",
            "Similar organizations at unrelated addresses must not be rescued",
            (LabeledRecord("A1", "a-firm", "Astoria Medical",
                           "111 Forest Road", "Kettering"),),
            (LabeledRecord("B1", "b-firm", "Astoria Medicines",
                           "400 Lake Street", "Kettering"),),
        ),
    )


def _mappings(include_region: bool) -> list[ManualMapping]:
    common = [
        ManualMapping(
            mappingId="name", label="Company", aColumn="organization",
            bColumn="company", role="identity", normalizer="text",
            semanticFamily="name_or_title",
        ),
        ManualMapping(
            mappingId="address", label="Address", aColumn="street",
            bColumn="address", role="identity", normalizer="text",
            semanticFamily="address",
        ),
        ManualMapping(
            mappingId="city", label="City", aColumn="city",
            bColumn="locality", role="identity", normalizer="text",
            semanticFamily="geography",
        ),
    ]
    if include_region:
        common.append(ManualMapping(
            mappingId="state", label="State", aColumn="state",
            bColumn="region", role="identity", normalizer="text",
            semanticFamily="geography",
        ))
    return common


def _visible(row: LabeledRecord, side: str) -> dict[str, str]:
    if side == "A":
        return {
            "id": row.row_id, "organization": row.name,
            "street": row.street, "city": row.city, "state": row.state,
        }
    return {
        "id": row.row_id, "company": row.name,
        "address": row.street, "locality": row.city, "region": row.state,
    }


def evaluate_adversarial_scenario(
    scenario: Scenario, *, max_bucket_pair_count: int = 100
) -> dict[str, object]:
    """Evaluate actual matcher behavior before revealing canonical identities."""

    a_rows = [_visible(row, "A") for row in scenario.a]
    b_rows = [_visible(row, "B") for row in scenario.b]
    mappings = _mappings(scenario.include_region)
    baseline = generate_candidates(
        A_HEADERS, a_rows, B_HEADERS, b_rows, mappings, CandidateEngineConfig()
    )
    probe = generate_address_location_candidates(
        A_HEADERS, a_rows, B_HEADERS, b_rows, mappings,
        max_bucket_pair_count=max_bucket_pair_count,
    )
    baseline_pairs = {(c.aRowId, c.bRowId) for c in baseline.candidates}
    added = probe.candidate_pairs - baseline_pairs
    a_by_id = {row["id"]: row for row in a_rows}
    b_by_id = {row["id"]: row for row in b_rows}
    matcher_config = MatcherConfig()
    baseline_scored = score_generated_candidates(
        baseline.candidates, a_by_id, b_by_id, mappings, matcher_config
    )
    added_scored = [
        score_candidate(
            a_id, b_id, a_by_id[a_id], b_by_id[b_id], mappings,
            [BlockingEvidenceView(
                blockerId="sw-054-evaluation-only-address-probe",
                keyHash=hashlib.sha256(f"{a_id}\0{b_id}".encode()).hexdigest()[:16],
            )],
            matcher_config,
        )
        for a_id, b_id in sorted(added)
    ]
    baseline_result = build_match_result(
        A_HEADERS, a_rows, B_HEADERS, b_rows, baseline_scored, matcher_config
    )
    combined_result = build_match_result(
        A_HEADERS, a_rows, B_HEADERS, b_rows,
        baseline_scored + added_scored, matcher_config,
    )

    # Hidden labels are consulted only after both decisions have been built.
    truth = {
        (a.row_id, b.row_id)
        for a in scenario.a for b in scenario.b if a.entity == b.entity
    }

    def autos(result: object) -> set[tuple[str, str]]:
        return {
            (c.aRowId, c.bRowId)
            for c in result.candidates
            if c.rank == 1 and c.band == "auto_match"
        }

    def displayed(result: object) -> set[tuple[str, str]]:
        return {(c.aRowId, c.bRowId) for c in result.candidates}

    base_auto = autos(baseline_result)
    combined_auto = autos(combined_result)
    added_auto = combined_auto - base_auto
    false_added_auto = added_auto - truth
    scored_by_pair = {
        (item.aRowId, item.bRowId): item.matchScore for item in added_scored
    }
    return {
        "adversarialVersion": ADVERSARIAL_VERSION,
        "scenario": scenario.key,
        "description": scenario.description,
        "candidateEngineVersion": baseline.engineVersion,
        "matcherVersion": matcher_config.matcherVersion,
        "confirmedRegionMapping": scenario.include_region,
        "aRows": len(a_rows),
        "bRows": len(b_rows),
        "truePairs": len(truth),
        "baselineCandidates": len(baseline_pairs),
        "probeOnlyCandidates": len(added),
        "probeOnlyTruePairs": len(added & truth),
        "probeOnlyFalsePairs": len(added - truth),
        "baselineWrongAutoMatches": len(base_auto - truth),
        "combinedWrongAutoMatches": len(combined_auto - truth),
        "newWrongAutoMatches": len(false_added_auto),
        "newWrongAutoPairScores": [
            {"aRowId": a, "bRowId": b, "score": scored_by_pair.get((a, b))}
            for a, b in sorted(false_added_auto)
        ],
        "baselineVisibleTruth": len(displayed(baseline_result) & truth),
        "combinedVisibleTruth": len(displayed(combined_result) & truth),
        "baselineReviewRows": len({
            c.aRowId for c in baseline_result.candidates
            if c.rank == 1 and c.band == "needs_review"
        }),
        "combinedReviewRows": len({
            c.aRowId for c in combined_result.candidates
            if c.rank == 1 and c.band == "needs_review"
        }),
        "scope": "hand-constructed synthetic complete truth; no production changes",
    }


def run_adversarial_scenarios() -> list[dict[str, object]]:
    return [
        evaluate_adversarial_scenario(scenario)
        for scenario in adversarial_scenarios()
    ]


if __name__ == "__main__":
    for case in run_adversarial_scenarios():
        print(json.dumps(case, sort_keys=True), flush=True)
