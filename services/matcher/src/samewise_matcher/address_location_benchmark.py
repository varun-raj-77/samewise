"""Versioned synthetic 1K/10K address-rescue benchmark with complete hidden truth.

The product candidate engine and evaluation-only probe see visible columns
only. Paired identity labels are introduced after both candidate passes finish.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import time
import tracemalloc
from dataclasses import dataclass
from typing import Any

from samewise_matcher.address_location_probe import (
    evaluate_address_location_probe,
    generate_address_location_candidates,
)
from samewise_matcher.candidate_engine import (
    CandidateEngineConfig,
    generate_candidates,
)
from samewise_matcher.workflow_models import ManualMapping

FIXTURE_VERSION = "address-rescue-synthetic-v0.1.0"
BENCHMARK_VERSION = "sw-052-address-rescue-benchmark-v0.1.0"
A_HEADERS = ["id", "organization", "street", "city"]
B_HEADERS = ["id", "company", "address", "locality"]
STREETS = (
    "Maple", "Oak", "Pine", "Cedar", "Willow", "Birch",
    "Highland", "Forest", "Harbor", "Summit", "Riverside", "Hill",
)
CITIES = (
    "Boston", "Cleveland", "Austin", "Denver", "Madison", "Tampa",
    "Seattle", "Columbus", "Phoenix", "Boulder", "Portland", "Houston",
)


@dataclass(frozen=True)
class AddressRescueFixture:
    a_rows: list[dict[str, str]]
    b_rows: list[dict[str, str]]
    truth_pairs: set[tuple[str, str]]
    known_hard_negatives: set[tuple[str, str]]
    category_counts: dict[str, int]
    fingerprint: str


def _letters(value: int) -> str:
    """Unique pronounceability-neutral brand tag, never a source row ID."""
    result = []
    for _ in range(5):
        result.append(chr(ord("a") + value % 26))
        value //= 26
    return "".join(reversed(result))


def _place(location: int, *, abbreviated: bool = False) -> str:
    ending = "St" if abbreviated else "Street"
    return f"{1000 + location} {STREETS[location % len(STREETS)]} {ending}"


def confirmed_mappings() -> list[ManualMapping]:
    return [
        ManualMapping(
            mappingId="org", label="Organization", aColumn="organization",
            bColumn="company", role="identity", normalizer="text",
            semanticFamily="name_or_title",
        ),
        ManualMapping(
            mappingId="street", label="Street", aColumn="street",
            bColumn="address", role="identity", normalizer="text",
            semanticFamily="address",
        ),
        ManualMapping(
            mappingId="locality", label="Locality", aColumn="city",
            bColumn="locality", role="identity", normalizer="text",
            semanticFamily="geography",
        ),
    ]


def generate_address_rescue_fixture(
    rows_per_side: int, *, seed: int = 5201
) -> AddressRescueFixture:
    """Derive independently ordered A/B records; truth is kept outside rows."""

    if rows_per_side < 20 or rows_per_side % 20:
        raise ValueError("Fixture size must be a multiple of 20, at least 20")
    rng = random.Random(seed)
    # Exactly 20% of entities occupy a shared four-entity address block.
    shared_count = rows_per_side // 5
    group_count = shared_count // 4
    b_permutation = list(range(rows_per_side))
    rng.shuffle(b_permutation)
    b_ids = [f"B-{position + 1}" for position in b_permutation]
    a_rows: list[dict[str, str]] = []
    b_rows: list[dict[str, str]] = []
    truth_pairs: set[tuple[str, str]] = set()
    categories = {
        "renamed": 0, "moved_address": 0, "missing_b_address": 0,
        "missing_b_geography": 0, "shared_address_entities": shared_count,
        "shared_address_groups": group_count,
    }

    for i in range(rows_per_side):
        shared = i < shared_count
        location = i // 4 if shared else group_count + i - shared_count
        city = CITIES[location % len(CITIES)]
        old_name = f"Orion {_letters(i)} Equipment LLC"
        renamed = i % 4 == 0
        moved = i % 17 == 0
        missing_address = i % 29 == 0
        missing_geography = i % 37 == 0
        for label, included in (
            ("renamed", renamed),
            ("moved_address", moved),
            ("missing_b_address", missing_address),
            ("missing_b_geography", missing_geography),
        ):
            categories[label] += int(included)

        a_id = f"A-{i + 1}"
        b_id = b_ids[i]
        a_rows.append({
            "id": a_id,
            "organization": old_name,
            "street": _place(location, abbreviated=i % 2 == 0),
            "city": city.lower() if i % 3 == 0 else city,
        })
        b_rows.append({
            "id": b_id,
            "company": (
                f"Solstice {_letters(i + rows_per_side + 100_000)} Ventures Ltd"
                if renamed else old_name.replace("LLC", "Ltd")
            ),
            "address": (
                "" if missing_address else _place(
                    location + rows_per_side * 2 if moved else location,
                    abbreviated=i % 2 == 1,
                )
            ),
            "locality": "" if missing_geography else city.upper(),
        })
        truth_pairs.add((a_id, b_id))

    # Ground-truth negatives are derived independently of candidate results.
    hard_negatives = {
        (f"A-{i + 1}", b_ids[j])
        for group in range(group_count)
        for i in range(group * 4, group * 4 + 4)
        for j in range(group * 4, group * 4 + 4)
        if i != j
    }
    rng.shuffle(a_rows)
    rng.shuffle(b_rows)
    fingerprint = hashlib.sha256(json.dumps(
        {"a": a_rows, "b": b_rows, "truth": sorted(truth_pairs)},
        sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest()
    return AddressRescueFixture(
        a_rows, b_rows, truth_pairs, hard_negatives, categories, fingerprint,
    )


def _measure(call: Any) -> tuple[Any, float, int]:
    tracemalloc.start()
    started = time.perf_counter()
    try:
        result = call()
        elapsed = round(time.perf_counter() - started, 6)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    return result, elapsed, peak


def run_address_rescue_benchmark(
    rows_per_side: int,
    *,
    seed: int = 5201,
    max_bucket_size_per_side: int = 20,
    max_bucket_pair_count: int = 100,
) -> dict[str, object]:
    fixture = generate_address_rescue_fixture(rows_per_side, seed=seed)
    mappings = confirmed_mappings()
    config = CandidateEngineConfig()

    # Critically, neither generation receives the fixture's truth or labels.
    baseline, baseline_seconds, baseline_peak = _measure(
        lambda: generate_candidates(
            A_HEADERS, fixture.a_rows, B_HEADERS, fixture.b_rows,
            mappings, config,
        )
    )
    probe, probe_seconds, probe_peak = _measure(
        lambda: generate_address_location_candidates(
            A_HEADERS, fixture.a_rows, B_HEADERS, fixture.b_rows, mappings,
            max_bucket_size_per_side=max_bucket_size_per_side,
            max_bucket_pair_count=max_bucket_pair_count,
        )
    )
    measured = evaluate_address_location_probe(
        baseline, probe, fixture.truth_pairs, fixture.known_hard_negatives
    )
    # The synthetic fixture has one complete true counterpart per A/B row:
    # every generated non-truth pair is definitively negative on this fixture.
    baseline_pairs = {
        (item.aRowId, item.bRowId) for item in baseline.candidates
    }
    added_pairs = probe.candidate_pairs - baseline_pairs
    return {
        "benchmarkVersion": BENCHMARK_VERSION,
        "fixtureVersion": FIXTURE_VERSION,
        "seed": seed,
        "fixtureSha256": fixture.fingerprint,
        "candidateConfig": config.model_dump(mode="json"),
        "probeCaps": {
            "maxBucketSizePerSide": max_bucket_size_per_side,
            "maxBucketPairCount": max_bucket_pair_count,
        },
        "scenarios": fixture.category_counts,
        "candidateMetrics": {
            **measured,
            "completeTruthNewlyAdmittedFalseCandidates": len(
                added_pairs - fixture.truth_pairs
            ),
            "completeTruthBaselineFalseCandidates": len(
                baseline_pairs - fixture.truth_pairs
            ),
        },
        "performance": {
            "baselineSeconds": baseline_seconds,
            "probeSeconds": probe_seconds,
            "baselinePeakTracedPythonBytes": baseline_peak,
            "probePeakTracedPythonBytes": probe_peak,
            "memoryMeasurement": (
                "tracemalloc peak allocations per stage, not process RSS; "
                "probe measured with baseline result already alive"
            ),
        },
        "scope": "synthetic complete truth; candidate generation only, no scoring",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", type=int, nargs="+", default=[1000, 10000])
    parser.add_argument("--seed", type=int, default=5201)
    parser.add_argument("--max-bucket-size", type=int, default=20)
    parser.add_argument("--max-bucket-pairs", type=int, default=100)
    args = parser.parse_args()
    for size in args.sizes:
        report = run_address_rescue_benchmark(
            size, seed=args.seed,
            max_bucket_size_per_side=args.max_bucket_size,
            max_bucket_pair_count=args.max_bucket_pairs,
        )
        print(json.dumps(report, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
