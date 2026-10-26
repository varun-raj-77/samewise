import type { CandidatePair } from "@samewise/contracts";
import { describe, expect, it } from "vitest";

import { analyzeReviewDemand } from "../src/review-demand-analysis.js";
import type { IdentityTruthFixture } from "../src/one-to-one-benchmark.js";

function pair(
  aRowId: string,
  bRowId: string,
  band: "auto_match" | "needs_review" = "auto_match",
  rank = 1,
  collision = false,
): CandidatePair {
  return {
    candidateId: `${aRowId}:${bRowId}`, aRowId, bRowId,
    band, rank, collision,
  } as CandidatePair;
}
const truth: IdentityTruthFixture = {
  source_a: [
    { source_row_id: "A1", canonical_entity_id: "e1" },
    { source_row_id: "A2", canonical_entity_id: "e2" },
    { source_row_id: "A3", canonical_entity_id: "e3" },
  ],
  source_b: [
    { source_row_id: "B1", canonical_entity_id: "e1" },
    { source_row_id: "B2", canonical_entity_id: "e2" },
    { source_row_id: "B3", canonical_entity_id: "e4" },
  ],
};
const generated = (pairs: CandidatePair[]) => pairs.map(p => ({aRowId:p.aRowId,bRowId:p.bRowId}));

describe("SW-026 review-demand accounting", () => {
  it("separates individual scorer abstention from global shared-B assignment conflict", () => {
    const pairs = [
      pair("A1", "B1"),
      pair("A2", "B1"),
      pair("A3", "B3", "needs_review"),
    ];
    const result = analyzeReviewDemand(truth, generated(pairs), pairs);
    expect(result.denominators).toMatchObject({
      sourceARows: 3, candidateBearingARows: 3, automaticARows: 0,
      reviewRoutedARows: 3, noRetainedCandidateARows: 0,
    });
    expect(result.reviewedByCause.shared_b_candidate).toBe(2);
    expect(result.reviewedByCause.matcher_needs_review).toBe(1);
    expect(result.reviewedByTruthEvidence.top_rank_true).toBe(1);
    expect(result.reviewedByTruthEvidence.no_cross_source_identity).toBe(1);
    expect(result.causeByTruthEvidence.shared_b_candidate.top_rank_true).toBe(1);
    expect(result.invariants).toMatchObject({reviewCausesReconcile:true,truthEvidenceCountsReconcile:true});
  });

  it("distinguishes duplicate-entity truth from unique identity and source-only records", () => {
    const dupTruth: IdentityTruthFixture = {
      source_a:[
        {source_row_id:"A1",canonical_entity_id:"e1"},
        {source_row_id:"A2",canonical_entity_id:"e1"},
        {source_row_id:"A3",canonical_entity_id:"alone"},
      ],
      source_b:[{source_row_id:"B1",canonical_entity_id:"e1"}],
    };
    const pairs = [pair("A1","B1"),pair("A2","B1")];
    const result = analyzeReviewDemand(dupTruth, generated(pairs), pairs);
    expect(result.denominators).toMatchObject({
      reviewRoutedARows:2,matchableARows:2,noRetainedCandidateARows:1,
    });
    expect(result.reviewedByTruthClass.duplicated_cross_source_identity).toBe(2);
    expect(result.noCandidateByTruthClass.no_cross_source_identity).toBe(1);
    expect(result.reviewedByCause.shared_b_candidate).toBe(2);
    // A true pair is not evidence that either duplicate can be auto-linked safely.
    expect(result.reviewedByTruthEvidence.top_rank_true).toBe(2);
  });

  it("classifies rank-one truth vs a surviving alternative vs lost scoring vs lost generation", () => {
    const pairs = [
      pair("A1","B3","needs_review"),
      pair("A1","B1","needs_review",2),
      pair("A2","B3","needs_review"),
    ];
    const result = analyzeReviewDemand(truth, [...generated(pairs),{aRowId:"A2",bRowId:"B2"}], pairs);
    expect(result.reviewedByTruthEvidence.retained_true_alternative).toBe(1);
    expect(result.reviewedByTruthEvidence.generated_true_not_retained).toBe(1);
    expect(result.noCandidateByTruthClass.no_cross_source_identity).toBe(1);
    const missing = analyzeReviewDemand(truth,generated(pairs),pairs);
    expect(missing.reviewedByTruthEvidence.true_not_generated).toBe(1);
  });

  it("distinguishes explicit matcher collision and malformed multi-top proposals", () => {
    const options = [pair("A1","B1","auto_match",1,true),pair("A2","B2","auto_match",1),
      pair("A2","B3","auto_match",1)];
    const result = analyzeReviewDemand(truth,generated(options),options);
    expect(result.reviewedByCause.matcher_collision_hint).toBe(1);
    expect(result.reviewedByCause.multiple_rank_one_automatic_proposals).toBe(1);
    expect(result.reviewedByCause.shared_b_candidate).toBe(0);
    expect(result.denominators.automaticARows).toBe(0);
  });

  it("counts an uncontested auto pair as assigned, not reviewed", () => {
    const pairs = [pair("A1","B1"),pair("A2","B2","needs_review")];
    const result = analyzeReviewDemand(truth,generated(pairs),pairs);
    expect(result.denominators).toMatchObject({automaticARows:1,reviewRoutedARows:1,candidateBearingARows:2});
    expect(result.reviewedByCause.matcher_needs_review).toBe(1);
    expect(result.reviewedByTruthClass.unique_cross_source_identity).toBe(1);
  });

  it("counts independent local threshold, margin, contradiction and collision evidence without treating overlaps as separate reviews", () => {
    const first = {
      ...pair("A1", "B1", "needs_review"), matchScore: 0.47,
      runnerUpMargin: 0.02, strongContradiction: true, collision: true,
    };
    const second = {
      ...pair("A2", "B2", "needs_review"), matchScore: 0.8,
      runnerUpMargin: 0.01, strongContradiction: false,
    };
    const analysis = analyzeReviewDemand(truth, generated([first, second]), [first, second], {
      decisions: { autoMatchThreshold: 0.5, minimumTopCandidateMargin: 0.04 },
    });
    expect(analysis.denominators.reviewRoutedARows).toBe(2);
    expect(analysis.reviewedByCause.matcher_needs_review).toBe(2);
    expect(analysis.localMatcherGateEvidence).toMatchObject({
      decisionRules: {autoMatchThreshold:0.5, minimumTopCandidateMargin:0.04},
      flagsAmongMatcherNeedsReview: {
        below_auto_score_threshold:1, below_minimum_top_margin:2,
        strong_contradiction:1, matcher_collision_flag:1, no_observable_blocker:0,
      },
    });
  });

  it("rejects candidates outside the truth fixture before producing misleading denominators", () => {
    expect(() => analyzeReviewDemand(truth,[{aRowId:"A9",bRowId:"B1"}],[]))
      .toThrow(/unknown source row/);
    expect(() => analyzeReviewDemand(truth,[],[pair("A1","B9")]))
      .toThrow(/unknown source row/);
  });
});
