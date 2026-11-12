"""Evaluation-only audit of address-rescue effects on actual matcher decisions.

Generate candidates without truth, apply unchanged scoring and review rules,
then compare both result sets against hidden complete synthetic truth.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from typing import Any

from samewise_matcher.address_location_benchmark import (
    A_HEADERS,
    B_HEADERS,
    confirmed_mappings,
    generate_address_rescue_fixture,
)
from samewise_matcher.address_location_probe import (
    generate_address_location_candidates,
)
from samewise_matcher.candidate_engine import (
    CandidateEngineConfig,
    generate_candidates,
)
from samewise_matcher.explainable_matcher import (
    MatcherConfig,
    build_match_result,
    score_candidate,
    score_generated_candidates,
)
from samewise_matcher.workflow_models import BlockingEvidenceView, MatcherResult

AUDIT_VERSION = "sw-053-address-rescue-decision-audit-v0.1.0"
PROBE_BLOCKER_LABEL = "sw-053-evaluation-only-street-locality"


def _decision_metrics(
    result: MatcherResult,
    truth_pairs: set[tuple[str, str]],
    generated_pairs: set[tuple[str, str]],
) -> dict[str, int | float | None]:
    displayed_pairs = {
        (item.aRowId, item.bRowId) for item in result.candidates
    }
    first_rank = [item for item in result.candidates if item.rank == 1]
    auto_pairs = {
        (item.aRowId, item.bRowId)
        for item in first_rank
        if item.band == "auto_match"
    }
    review_a_ids = {
        item.aRowId for item in first_rank if item.band == "needs_review"
    }
    selected = {(item.aRowId, item.bRowId) for item in first_rank}
    return {
        "generatedCandidatePairs": len(generated_pairs),
        "generatedTruePairs": len(generated_pairs & truth_pairs),
        "displayedCandidatePairs": len(displayed_pairs),
        "displayedTruePairs": len(displayed_pairs & truth_pairs),
        "displayedFalsePairs": len(displayed_pairs - truth_pairs),
        "trueLinksGeneratedButNotDisplayed": len(
            (generated_pairs & truth_pairs) - displayed_pairs
        ),
        "topRankedTruePairs": len(selected & truth_pairs),
        "topRankedFalsePairs": len(selected - truth_pairs),
        "autoMatchedPairs": len(auto_pairs),
        "correctAutoMatchedPairs": len(auto_pairs & truth_pairs),
        "incorrectAutoMatchedPairs": len(auto_pairs - truth_pairs),
        "autoMatchPrecision": (
            round(len(auto_pairs & truth_pairs) / len(auto_pairs), 9)
            if auto_pairs else None
        ),
        "reviewEntityRows": len(review_a_ids),
        "reviewCandidatePairs": sum(
            item.band == "needs_review" for item in result.candidates
        ),
        "collisionTopCandidates": sum(item.collision for item in first_rank),
        "onlyARows": len(result.onlyA),
        "onlyBRows": len(result.onlyB),
    }


def run_decision_audit(
    rows_per_side: int, *,
    seed: int = 5201,
    max_bucket_pair_count: int = 100,
) -> dict[str, Any]:
    fixture = generate_address_rescue_fixture(rows_per_side, seed=seed)
    mappings = confirmed_mappings()
    candidates = generate_candidates(
        A_HEADERS, fixture.a_rows, B_HEADERS, fixture.b_rows,
        mappings, CandidateEngineConfig(),
    )
    proposed = generate_address_location_candidates(
        A_HEADERS, fixture.a_rows, B_HEADERS, fixture.b_rows, mappings,
        max_bucket_pair_count=max_bucket_pair_count,
    )
    base_pairs = {
        (item.aRowId, item.bRowId) for item in candidates.candidates
    }
    added_pairs = proposed.candidate_pairs - base_pairs
    combined_pairs = base_pairs | proposed.candidate_pairs
    a_by_id = {row["id"]: row for row in fixture.a_rows}
    b_by_id = {row["id"]: row for row in fixture.b_rows}

    matcher_config = MatcherConfig()
    scoring_started = time.perf_counter()
    baseline_scored = score_generated_candidates(
        candidates.candidates, a_by_id, b_by_id, mappings, matcher_config,
    )
    # This explicit evidence marker exists only in the audit result. It is not
    # a product blocker or fabricated address_name_v2 provenance. The matcher
    # weights and decision rules are identical in both conditions.
    extra_scored = [
        score_candidate(
            a_id, b_id, a_by_id[a_id], b_by_id[b_id], mappings,
            [
                BlockingEvidenceView(
                    blockerId=PROBE_BLOCKER_LABEL,
                    keyHash=hashlib.sha256(
                        f"{a_id}\0{b_id}".encode()
                    ).hexdigest()[:16],
                )
            ],
            matcher_config,
        )
        for a_id, b_id in sorted(added_pairs)
    ]
    scoring_seconds = round(time.perf_counter() - scoring_started, 6)
    baseline_result = build_match_result(
        A_HEADERS, fixture.a_rows, B_HEADERS, fixture.b_rows,
        baseline_scored, matcher_config,
    )
    combined_result = build_match_result(
        A_HEADERS, fixture.a_rows, B_HEADERS, fixture.b_rows,
        baseline_scored + extra_scored, matcher_config,
    )

    # Only now is truth used, never by generation, feature extraction,
    # scoring, sorting, alternative cutoff or the actual decision rules.
    baseline = _decision_metrics(
        baseline_result, fixture.truth_pairs, base_pairs,
    )
    combined = _decision_metrics(
        combined_result, fixture.truth_pairs, combined_pairs,
    )
    baseline_auto = {
        (c.aRowId, c.bRowId)
        for c in baseline_result.candidates
        if c.rank == 1 and c.band == "auto_match"
    }
    combined_auto = {
        (c.aRowId, c.bRowId)
        for c in combined_result.candidates
        if c.rank == 1 and c.band == "auto_match"
    }
    return {
        "auditVersion": AUDIT_VERSION,
        "fixtureSha256": fixture.fingerprint,
        "fixtureVersion": "address-rescue-synthetic-v0.1.0",
        "seed": seed,
        "rowsPerSide": rows_per_side,
        "maxBucketPairCount": max_bucket_pair_count,
        "baselineMatcherVersion": matcher_config.matcherVersion,
        "baselineCandidateEngineVersion": candidates.engineVersion,
        "evaluationOnlyEvidenceMarker": PROBE_BLOCKER_LABEL,
        "baseline": baseline,
        "withAddressProbe": combined,
        "delta": {
            "additionalCandidatePairs": len(added_pairs),
            "truePairsNewlyGenerated": len(
                combined_pairs & fixture.truth_pairs
            ) - len(base_pairs & fixture.truth_pairs),
            "truePairsNewlyDisplayed": (
                combined["displayedTruePairs"] - baseline["displayedTruePairs"]
            ),
            "reviewEntityRowsChange": (
                combined["reviewEntityRows"] - baseline["reviewEntityRows"]
            ),
            "reviewCandidatePairsChange": (
                combined["reviewCandidatePairs"]
                - baseline["reviewCandidatePairs"]
            ),
            "newlyAutoMatchedTruePairs": len(
                (combined_auto - baseline_auto) & fixture.truth_pairs
            ),
            "newlyAutoMatchedFalsePairs": len(
                (combined_auto - baseline_auto) - fixture.truth_pairs
            ),
            "formerlyAutoMatchedPairsDisplaced": len(
                baseline_auto - combined_auto
            ),
        },
        "scoringSeconds": scoring_seconds,
        "scope": (
            "complete synthetic 1:1 truth; unchanged matcher score, "
            "rank, collision and decision rules; not production behavior"
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", type=int, nargs="+", default=[1000])
    parser.add_argument("--seeds", type=int, nargs="+", default=[5201, 5301])
    parser.add_argument("--bucket-caps", type=int, nargs="+", default=[4, 100])
    args = parser.parse_args()
    for size in args.sizes:
        for seed in args.seeds:
            for cap in args.bucket_caps:
                report = run_decision_audit(
                    size, seed=seed, max_bucket_pair_count=cap,
                )
                print(json.dumps(report, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
