import type { CandidatePair } from "@samewise/contracts";

import { automaticIdentityCandidateIds } from "./identity-selection.js";
import type { IdentityTruthFixture } from "./one-to-one-benchmark.js";

export const E2E_MATCHER_EVALUATION_VERSION = "e2e-matcher-evaluation-v1" as const;

export interface VisibleCandidate {
  aRowId: string;
  bRowId: string;
}

function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}
function pairKey(a: string, b: string): string {
  return JSON.stringify([a, b]);
}
function indexTruth(rows: IdentityTruthFixture["source_a"], side: string): Map<string, string> {
  const output = new Map<string, string>();
  for (const row of rows) {
    if (!row.source_row_id || !row.canonical_entity_id || output.has(row.source_row_id)) {
      throw new Error(`Invalid or repeated source ${side} row identifier in truth.`);
    }
    output.set(row.source_row_id, row.canonical_entity_id);
  }
  if (!output.size) throw new Error(`Empty source ${side} truth.`);
  return output;
}
function indexPairs(pairs: VisibleCandidate[], a: Map<string, string>, b: Map<string, string>, stage: string): Set<string> {
  const seen = new Set<string>();
  for (const p of pairs) {
    if (!a.has(p.aRowId) || !b.has(p.bRowId)) {
      throw new Error(`${stage} returned an out-of-fixture row.`);
    }
    const key = pairKey(p.aRowId, p.bRowId);
    if (seen.has(key)) throw new Error(`Repeated pair from ${stage}.`);
    seen.add(key);
  }
  return seen;
}
export function measureActualMatcherStages(
  truth: IdentityTruthFixture,
  generated: VisibleCandidate[],
  retained: CandidatePair[],
) {
  const a = indexTruth(truth.source_a, "A");
  const b = indexTruth(truth.source_b, "B");
  const truthKeys = new Set<string>();
  const bByCanonical = new Map<string, string[]>();
  for (const [id, entity] of b) {
    const arr = bByCanonical.get(entity) ?? [];
    arr.push(id);
    bByCanonical.set(entity, arr);
  }
  const matchableA = new Set<string>();
  for (const [id, entity] of a) {
    const otherRows = bByCanonical.get(entity) ?? [];
    if (otherRows.length) matchableA.add(id);
    for (const other of otherRows) truthKeys.add(pairKey(id, other));
  }
  if (!truthKeys.size) throw new Error("Fixture has no cross-source ground-truth pairs.");
  const generatedSet = indexPairs(generated, a, b, "candidate generation");
  const retainedSet = indexPairs(retained, a, b, "scored/retained matcher");
  for (const key of retainedSet) {
    if (!generatedSet.has(key)) throw new Error("The production matcher retained a pair absent from the same-config generator.");
  }
  const generatedTrue = [...truthKeys].filter(key => generatedSet.has(key)).length;
  const retainedTrue = [...truthKeys].filter(key => retainedSet.has(key)).length;
  if (retainedTrue > generatedTrue) throw new Error("Retained true links exceed generated true links.");

  const candidateBearingA = new Set(retained.map(p => p.aRowId));
  const selectedIds = automaticIdentityCandidateIds(retained);
  const selected = retained.filter(p => selectedIds.has(p.candidateId));
  const selectedA = new Set(selected.map(p => p.aRowId));
  const selectedB = new Set(selected.map(p => p.bRowId));
  if (selectedA.size !== selected.length || selectedB.size !== selected.length) {
    throw new Error("Automatic assignment violates one-to-one identity uniqueness.");
  }
  const trueAuto = selected.filter(p => truthKeys.has(pairKey(p.aRowId, p.bRowId))).length;
  const top = retained.filter(p => p.rank === 1);
  const topCorrect = top.filter(p => truthKeys.has(pairKey(p.aRowId, p.bRowId))).length;
  const reviewARows = [...candidateBearingA].filter(id => !selectedA.has(id));
  const missedTruthPairs = [...truthKeys].filter(key => !generatedSet.has(key));
  return {
    rowCounts: {
      a: a.size, b: b.size, aMatchable: matchableA.size,
      truthPairs: truthKeys.size, candidateBearingARows: candidateBearingA.size,
      trueDuplicatePairSurplus: truthKeys.size - matchableA.size,
    },
    stages: {
      generatedPairs: generatedSet.size,
      generatedTruePairs: generatedTrue,
      candidateRecall: ratio(generatedTrue, truthKeys.size),
      candidateReduction: 1 - generatedSet.size / (a.size * b.size),
      generatedTruePairsLostInScoringOrRetention: generatedTrue - retainedTrue,
      retainedPairs: retainedSet.size,
      retainedTruePairs: retainedTrue,
      retainedTruthPairRecall: ratio(retainedTrue, truthKeys.size),
      retainedPairReduction: 1 - retainedSet.size / (a.size * b.size),
      // Retained top-one rows, not a true pre-pruning ranking metric.
      retainedTopRankCount: top.length,
      retainedTopRankCorrectCount: topCorrect,
      retainedTopRankPrecision: ratio(topCorrect, top.length),
    },
    assignment: {
      policy: "assignment-one-to-one-conservative-v1",
      autoAssignedPairs: selected.length,
      trueAutoAssignedPairs: trueAuto,
      falseAutoAssignedPairs: selected.length - trueAuto,
      autoMatchPrecision: ratio(trueAuto, selected.length),
      autoMatchTruthPairRecall: ratio(trueAuto, truthKeys.size),
      autoMatchMatchableARowRecall: ratio(trueAuto, matchableA.size),
      reviewRoutedARows: reviewARows.length,
      reviewRateAllARows: ratio(reviewARows.length, a.size),
      reviewRateMatchableARows: ratio(reviewARows.filter(id => matchableA.has(id)).length, matchableA.size),
      noRetainedCandidateARows: a.size - candidateBearingA.size,
      duplicateBClaims: selected.length - selectedB.size,
    },
    errorExamples: {
      // IDs only. No source values or hidden truth embedded into matcher inputs.
      generatedMisses: missedTruthPairs.slice(0, 10).map(key => JSON.parse(key) as [string, string]),
      falseAutoPairs: selected.filter(p => !truthKeys.has(pairKey(p.aRowId,p.bRowId)))
        .slice(0, 10).map(p => [p.aRowId, p.bRowId]),
    },
  };
}
