import type { CandidatePair } from "@samewise/contracts";
import { describe, expect, it } from "vitest";

import { conservativeAutomaticIdentityCandidateIds, legacyAutomaticIdentityCandidateIds } from "../src/identity-selection.js";
import {
  analyzeOneToOneImpact,
  analyzeRecoveryImpact,
  measureSelectionRuntime,
  type IdentityTruthFixture,
} from "../src/one-to-one-benchmark.js";

const fixture: IdentityTruthFixture = {
  source_a: [
    { source_row_id: "A1", canonical_entity_id: "entity-x" },
    { source_row_id: "A2", canonical_entity_id: "entity-y" },
    { source_row_id: "A3", canonical_entity_id: "entity-z" },
  ],
  source_b: [
    { source_row_id: "B1", canonical_entity_id: "entity-x" },
    { source_row_id: "B2", canonical_entity_id: "entity-y" },
    { source_row_id: "B3", canonical_entity_id: "entity-other" },
  ],
};
function pair(aRowId: string, bRowId: string, band: "auto_match" | "needs_review" = "auto_match",
  rank = 1, collision = false): CandidatePair {
  return {
    candidateId: `candidate-${aRowId}-${bRowId}`, aRowId, bRowId, rank, band, collision,
  } as CandidatePair;
}
describe("SW-022 production selector vs frozen pre-SW-021 baseline", () => {
  it("isolates a shared B, detects one false positive, and measures added review cases", () => {
    const candidates = [pair("A1", "B1"), pair("A2", "B1")];
    const comparison = analyzeOneToOneImpact(candidates, fixture);
    expect(comparison.denominators).toMatchObject({
      sourceARows: 3, sourceBRows: 3, matchableARows: 2,
      truthCrossSourcePairs: 2, retainedTruePairs: 1,
      retainedCandidatePairRecall: 0.5, aRowsWithRetainedCandidates: 2,
    });
    expect(comparison.baseline).toMatchObject({
      autoAssignedPairs: 2, trueAutoPairs: 1, falseAutoPairs: 1,
      autoMatchPrecision: 0.5, reviewRoutedARows: 0, duplicateBClaims: 1,
    });
    expect(comparison.oneToOne).toMatchObject({
      autoAssignedPairs: 0, trueAutoPairs: 0, falseAutoPairs: 0,
      autoMatchPrecision: null, reviewRoutedARows: 2, duplicateBClaims: 0,
    });
    expect(comparison.delta).toMatchObject({
      trueAutoPairs: -1, falseAutoPairs: -1, reviewRoutedARows: 2, duplicateBClaims: -1,
      autoMatchPrecision: null,
    });
    expect(comparison.regressionInvariants).toEqual({
      uniqueBClaims: true, falseAutoPairsDidNotIncrease: true, retainedCandidateRecallUnchanged: true,
    });
  });

  it("keeps uncontested automatic links and preserves zero-cost review delta", () => {
    const comparison = analyzeOneToOneImpact([pair("A1", "B1"), pair("A2", "B2")], fixture);
    expect(comparison.baseline).toEqual(comparison.oneToOne);
    expect(comparison.baseline.autoMatchPrecision).toBe(1);
    expect(comparison.delta.reviewRateAllARows).toBe(0);
    expect(comparison.delta.autoAssignedARows).toBe(0);
    expect(comparison.oneToOne.autoMatchRecallPerMatchableARow).toBe(1);
  });

  it("treats a weaker retained alternative as contention, not as grounds for forced assignment", () => {
    const candidates = [pair("A1", "B1"), pair("A2", "B2"), pair("A2", "B1", "needs_review", 2)];
    expect([...legacyAutomaticIdentityCandidateIds(candidates)]).toHaveLength(2);
    expect([...conservativeAutomaticIdentityCandidateIds(candidates)]).toEqual(["candidate-A2-B2"]);
    const comparison = analyzeOneToOneImpact(candidates, fixture);
    expect(comparison.baseline.autoAssignedPairs).toBe(2);
    expect(comparison.oneToOne.autoAssignedPairs).toBe(1);
    expect(comparison.delta.falseAutoPairs).toBe(0);
    expect(comparison.delta.trueAutoPairs).toBe(-1);
    expect(comparison.delta.reviewRoutedARows).toBe(1);
    expect(comparison.denominators.retainedCandidatePairRecall).toBe(1);
  });

  it("represents duplicate-entity truth correctly without pretending one-to-one can recover every true link", () => {
    const duplicateTruth: IdentityTruthFixture = {
      source_a: [{ source_row_id: "A1", canonical_entity_id: "same" }, { source_row_id: "A2", canonical_entity_id: "same" }],
      source_b: [{ source_row_id: "B1", canonical_entity_id: "same" }],
    };
    const impact = analyzeOneToOneImpact([pair("A1", "B1"), pair("A2", "B1")], duplicateTruth);
    expect(impact.denominators.truthCrossSourcePairs).toBe(2);
    expect(impact.denominators.retainedCandidatePairRecall).toBe(1);
    expect(impact.baseline.autoMatchRecallPerMatchableARow).toBe(1);
    expect(impact.oneToOne.autoMatchRecallPerMatchableARow).toBe(0);
  });

  it("measures SW-023's one recovered correct anchor independently from the frozen SW-021 comparison", () => {
    const candidates = [
      pair("A1", "B1"), pair("A2", "B2"),
      pair("A2", "B1", "needs_review", 2),
    ];
    const impact = analyzeRecoveryImpact(candidates, fixture);
    expect(impact.sw021).toMatchObject({
      autoAssignedPairs: 1, trueAutoPairs: 1, falseAutoPairs: 0,
      reviewRoutedARows: 1,
    });
    expect(impact.sw023).toMatchObject({
      autoAssignedPairs: 2, trueAutoPairs: 2, falseAutoPairs: 0,
      reviewRoutedARows: 0, duplicateBClaims: 0,
    });
    expect(impact.delta).toMatchObject({
      autoAssignedPairs: 1, trueAutoPairs: 1, falseAutoPairs: 0,
      reviewRoutedARows: -1, duplicateBClaims: 0,
    });
    expect(impact.denominators.retainedCandidatePairRecall).toBe(1);
  });

  it("keeps genuine automatic B conflicts unresolved rather than improving metrics by forcing a winner", () => {
    const impact = analyzeRecoveryImpact([pair("A1", "B1"), pair("A2", "B1")], fixture);
    expect(impact.sw021.autoAssignedPairs).toBe(0);
    expect(impact.sw023.autoAssignedPairs).toBe(0);
    expect(impact.delta.reviewRoutedARows).toBe(0);
  });

  it("does not manufacture precision when no pair was automatically matched", () => {
    const impact = analyzeOneToOneImpact([pair("A1", "B1", "needs_review")], fixture);
    expect(impact.baseline.autoMatchPrecision).toBeNull();
    expect(impact.oneToOne.autoMatchPrecision).toBeNull();
    expect(impact.delta.autoMatchPrecision).toBeNull();
    expect(impact.baseline.reviewRateAllARows).toBeCloseTo(1 / 3);
  });

  it("rejects duplicate truth IDs and candidate pairs instead of reporting invalid fractions", () => {
    const duplicateTruth: IdentityTruthFixture = {
      ...fixture, source_a: [...fixture.source_a, fixture.source_a[0]!],
    };
    expect(() => analyzeOneToOneImpact([], duplicateTruth)).toThrow(/duplicate source IDs/);
    expect(() => analyzeOneToOneImpact([pair("A1", "B1"), pair("A1", "B1")], fixture))
      .toThrow(/Duplicate candidate pairs/);
    expect(() => analyzeOneToOneImpact([pair("A4", "B1")], fixture))
      .toThrow(/outside the held-out fixture/);
  });

  it("collects positive runtime samples from the production selector (no performance guarantee)", () => {
    const timing = measureSelectionRuntime([pair("A1", "B1"), pair("A2", "B2")], 5);
    expect(timing.repetitions).toBe(5);
    expect(timing.baselineMedianMs).toBeGreaterThanOrEqual(0);
    expect(timing.oneToOneMedianMs).toBeGreaterThanOrEqual(0);
    expect(() => measureSelectionRuntime([], 0)).toThrow();
  });
});
