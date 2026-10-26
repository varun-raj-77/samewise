import type { CandidatePair } from "@samewise/contracts";
import { describe, expect, it } from "vitest";

import { measureActualMatcherStages } from "../src/e2e-matcher-evaluation.js";
import type { IdentityTruthFixture } from "../src/one-to-one-benchmark.js";

const truth: IdentityTruthFixture = {
  source_a: [
    { source_row_id: "A1", canonical_entity_id: "E1" },
    { source_row_id: "A2", canonical_entity_id: "E2" },
    { source_row_id: "A3", canonical_entity_id: "E3" },
  ],
  source_b: [
    { source_row_id: "B1", canonical_entity_id: "E1" },
    { source_row_id: "B2", canonical_entity_id: "E2" },
    { source_row_id: "B3", canonical_entity_id: "E4" },
  ],
};
function pair(aRowId: string, bRowId: string, band: "auto_match"|"needs_review" = "auto_match", rank = 1): CandidatePair {
  return {candidateId:`pair-${aRowId}-${bRowId}`,aRowId,bRowId,band,rank,collision:false} as CandidatePair;
}
describe("SW-025 actual-stage metric boundaries", () => {
  it("separates upstream candidate recall, retained recall, and selected auto precision", () => {
    const result = measureActualMatcherStages(
      truth,
      [{aRowId:"A1",bRowId:"B1"},{aRowId:"A2",bRowId:"B2"},{aRowId:"A3",bRowId:"B3"}],
      [pair("A1","B1"),pair("A3","B3")],
    );
    expect(result.rowCounts).toMatchObject({a:3,b:3,truthPairs:2,aMatchable:2});
    expect(result.stages).toMatchObject({
      generatedPairs:3,generatedTruePairs:2,candidateRecall:1,
      retainedPairs:2,retainedTruePairs:1,retainedTruthPairRecall:.5,
      generatedTruePairsLostInScoringOrRetention:1,
    });
    expect(result.assignment).toMatchObject({
      autoAssignedPairs:2,trueAutoAssignedPairs:1,falseAutoAssignedPairs:1,
      autoMatchPrecision:.5,duplicateBClaims:0,
      reviewRoutedARows:0,noRetainedCandidateARows:1,
    });
  });

  it("measures globally competing automatic candidates as review rather than duplicate B links", () => {
    const result = measureActualMatcherStages(truth, [
      {aRowId:"A1",bRowId:"B1"},{aRowId:"A2",bRowId:"B1"},
    ],[pair("A1","B1"),pair("A2","B1")]);
    expect(result.stages.candidateRecall).toBe(.5);
    expect(result.assignment).toMatchObject({
      autoAssignedPairs:0,autoMatchPrecision:null,duplicateBClaims:0,
      reviewRoutedARows:2,reviewRateAllARows:2/3,
    });
  });

  it("does not collapse duplicate canonical truth into one pair or fabricate pair-level recall", () => {
    const duplicated: IdentityTruthFixture = {
      source_a: [
        {source_row_id:"A1",canonical_entity_id:"E1"},
        {source_row_id:"A2",canonical_entity_id:"E1"},
      ],
      source_b: [{source_row_id:"B1",canonical_entity_id:"E1"}],
    };
    const result = measureActualMatcherStages(duplicated, [
      {aRowId:"A1",bRowId:"B1"},{aRowId:"A2",bRowId:"B1"},
    ],[pair("A1","B1"),pair("A2","B1")]);
    expect(result.rowCounts).toMatchObject({truthPairs:2,aMatchable:2,trueDuplicatePairSurplus:0});
    expect(result.stages.candidateRecall).toBe(1);
    expect(result.assignment.autoAssignedPairs).toBe(0);
  });

  it("refuses mismatched generated/retained graphs or invalid truth instead of reporting spurious metrics", () => {
    expect(()=>measureActualMatcherStages(truth,[],[pair("A1","B1")]))
      .toThrow(/absent from the same-config generator/);
    expect(()=>measureActualMatcherStages(truth,[
      {aRowId:"A1",bRowId:"B1"},{aRowId:"A1",bRowId:"B1"},
    ],[])).toThrow(/Repeated pair/);
    expect(()=>measureActualMatcherStages(truth,[{aRowId:"A10",bRowId:"B1"}],[]))
      .toThrow(/out-of-fixture row/);
    expect(()=>measureActualMatcherStages({
      ...truth,source_b:[...truth.source_b,truth.source_b[0]!],
    },[],[])).toThrow(/repeated source B/);
  });
});
