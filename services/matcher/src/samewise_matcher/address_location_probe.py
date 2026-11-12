"""Evaluation-only address/location candidate rescue probe.

This module never changes the product candidate engine. Generation receives only
visible source records and confirmed semantic mappings; labels enter later.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

from samewise_matcher.blocking_normalization import normalize_address, normalize_text
from samewise_matcher.candidate_engine import CandidateGenerationResult
from samewise_matcher.workflow_models import ManualMapping

PROBE_VERSION = "address-location-probe-v0.1.0"


@dataclass(frozen=True)
class AddressLocationProbe:
    candidate_pairs: frozenset[tuple[str, str]]
    common_keys: int
    keys_used: int
    keys_suppressed: int
    relationships_suppressed: int


def _row_ids(
    headers: list[str], rows: list[dict[str, str]], side: str
) -> list[str]:
    if not headers:
        raise ValueError("Probe requires a source row ID column")
    ids = [
        row.get(headers[0], "").strip() or f"{side}-{index + 1}"
        for index, row in enumerate(rows)
    ]
    if len(ids) != len(set(ids)):
        raise ValueError("Probe requires unique source row IDs")
    return ids


def _value(row: dict[str, str], mapping: ManualMapping, side: str) -> str:
    return row.get(mapping.aColumn if side == "A" else mapping.bColumn, "")


def _index(
    headers: list[str],
    rows: list[dict[str, str]],
    side: str,
    addresses: list[ManualMapping],
    geographies: list[ManualMapping],
) -> dict[tuple[str, str, str, str], list[str]]:
    ids = _row_ids(headers, rows, side)
    index: dict[tuple[str, str, str, str], list[str]] = defaultdict(list)
    for row_id, row in zip(ids, rows, strict=True):
        address_values = {
            (mapping.mappingId, normalize_address(_value(row, mapping, side)))
            for mapping in addresses
        }
        geography_values = {
            (mapping.mappingId, normalize_text(_value(row, mapping, side)))
            for mapping in geographies
        }
        keys = {
            (address_id, address, geography_id, geography)
            for address_id, address in address_values
            for geography_id, geography in geography_values
            if address and geography
        }
        for key in sorted(keys):
            index[key].append(row_id)
    return index


def generate_address_location_candidates(
    a_headers: list[str],
    a_rows: list[dict[str, str]],
    b_headers: list[str],
    b_rows: list[dict[str, str]],
    mappings: list[ManualMapping],
    *,
    max_bucket_size_per_side: int = 20,
    max_bucket_pair_count: int = 100,
) -> AddressLocationProbe:
    """Probe exact normalized street + locality without a name dependency.

    No hidden truth, labels, scores, or product configuration are used.
    Shared buildings can create hard negatives; this does not establish identity.
    """

    if max_bucket_size_per_side < 1 or max_bucket_pair_count < 1:
        raise ValueError("Probe bucket caps must be positive")
    addresses = [
        mapping for mapping in mappings
        if mapping.role == "identity" and mapping.semanticFamily == "address"
    ]
    geographies = [
        mapping for mapping in mappings
        if mapping.role == "identity" and mapping.semanticFamily == "geography"
    ]
    if not addresses or not geographies:
        raise ValueError(
            "Probe requires confirmed identity address and geography mappings"
        )
    for mapping in addresses + geographies:
        if mapping.aColumn not in a_headers or mapping.bColumn not in b_headers:
            raise ValueError("Probe mapping references an absent source column")

    a_index = _index(a_headers, a_rows, "A", addresses, geographies)
    b_index = _index(b_headers, b_rows, "B", addresses, geographies)
    common = sorted(a_index.keys() & b_index.keys())
    pairs: set[tuple[str, str]] = set()
    used = suppressed = suppressed_relationships = 0
    for key in common:
        left, right = a_index[key], b_index[key]
        relationships = len(left) * len(right)
        if (
            len(left) > max_bucket_size_per_side
            or len(right) > max_bucket_size_per_side
            or relationships > max_bucket_pair_count
        ):
            suppressed += 1
            suppressed_relationships += relationships
            continue
        used += 1
        pairs.update((a_id, b_id) for a_id in left for b_id in right)
    return AddressLocationProbe(
        candidate_pairs=frozenset(pairs),
        common_keys=len(common),
        keys_used=used,
        keys_suppressed=suppressed,
        relationships_suppressed=suppressed_relationships,
    )


def evaluate_address_location_probe(
    baseline: CandidateGenerationResult,
    probe: AddressLocationProbe,
    truth_pairs: set[tuple[str, str]],
    known_hard_negative_pairs: set[tuple[str, str]],
) -> dict[str, object]:
    """Evaluate AFTER visible-data-only generation; never score candidate identity."""

    if truth_pairs & known_hard_negative_pairs:
        raise ValueError("Truth pairs and hard negatives must be disjoint")
    baseline_pairs = {
        (candidate.aRowId, candidate.bRowId) for candidate in baseline.candidates
    }
    combined = baseline_pairs | probe.candidate_pairs
    added = probe.candidate_pairs - baseline_pairs

    def recall(
        pairs: set[tuple[str, str]] | frozenset[tuple[str, str]],
    ) -> float | None:
        if not truth_pairs:
            return None
        return round(len(truth_pairs & pairs) / len(truth_pairs), 9)

    return {
        "probeVersion": PROBE_VERSION,
        "baselineCandidateEngineVersion": baseline.engineVersion,
        "sourceARows": baseline.aRowCount,
        "sourceBRows": baseline.bRowCount,
        "theoreticalPairs": baseline.aRowCount * baseline.bRowCount,
        "baselineCandidates": len(baseline_pairs),
        "probeCandidates": len(probe.candidate_pairs),
        "addedCandidates": len(added),
        "combinedCandidates": len(combined),
        "knownTruePairs": len(truth_pairs),
        "baselineTruePairsRetained": len(baseline_pairs & truth_pairs),
        "combinedTruePairsRetained": len(combined & truth_pairs),
        "newlyRecoveredTruePairs": len(added & truth_pairs),
        "baselineCandidateRecall": recall(baseline_pairs),
        "combinedCandidateRecall": recall(combined),
        "knownHardNegativePairs": len(known_hard_negative_pairs),
        "newlyAdmittedKnownHardNegatives": len(added & known_hard_negative_pairs),
        "additionalPairsWithoutKnownTruthLabel": len(
            added - truth_pairs - known_hard_negative_pairs
        ),
        "addressKeysConsidered": probe.common_keys,
        "addressKeysUsed": probe.keys_used,
        "addressKeysSuppressed": probe.keys_suppressed,
        "addressRelationshipsSuppressed": probe.relationships_suppressed,
    }
