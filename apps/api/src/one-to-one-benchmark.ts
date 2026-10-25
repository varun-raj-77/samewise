import { performance } from "node:perf_hooks";

import type { CandidatePair } from "@samewise/contracts";

import { automaticIdentityCandidateIds, legacyAutomaticIdentityCandidateIds } from "./identity-selection.js";

export const ONE_TO_ONE_BENCHMARK_VERSION = "one-to-one-impact-v1";

export interface SourceTruthRow {
  source_row_id: string;
  canonical_entity_id: string;
}
export interface IdentityTruthFixture {
  source_a: SourceTruthRow[];
  source_b: SourceTruthRow[];
}

interface SelectedPair {
  aRowId: string;
  bRowId: string;
  candidateId: string;
}

export interface AssignmentMetrics {
  autoAssignedARows: number;
  autoAssignedPairs: number;
  trueAutoPairs: number;
  falseAutoPairs: number;
  autoMatchPrecision: number | null;
  autoMatchRecallPerMatchableARow: number;
  reviewRoutedARows: number;
  reviewRateAllARows: number;
  reviewRateMatchableARows: number;
  duplicateBClaims: number;
}

function finiteRatio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function selectOnePerA(candidates: CandidatePair[], accepted: Set<string>): SelectedPair[] {
  const selected: SelectedPair[] = [];
  const seenA = new Set<string>();
  for (const candidate of candidates) {
    if (!accepted.has(candidate.candidateId) || seenA.has(candidate.aRowId)) continue;
    seenA.add(candidate.aRowId);
    selected.push({
      aRowId: candidate.aRowId,
      bRowId: candidate.bRowId,
      candidateId: candidate.candidateId,
    });
  }
  return selected;
}

function metrics(
  selected: SelectedPair[],
  allCandidateARows: Set<string>,
  truthA: Map<string, string>,
  truthB: Map<string, string>,
  matchableA: Set<string>,
): AssignmentMetrics {
  const selectedARows = new Set(selected.map((pair) => pair.aRowId));
  const claimCounts = new Map<string, number>();
  let trueAutoPairs = 0;
  for (const pair of selected) {
    claimCounts.set(pair.bRowId, (claimCounts.get(pair.bRowId) ?? 0) + 1);
    if (truthA.get(pair.aRowId) === truthB.get(pair.bRowId)) trueAutoPairs += 1;
  }
  const autoAssignedPairs = selected.length;
  const reviewRoutedARows = [...allCandidateARows].filter((aRowId) => !selectedARows.has(aRowId)).length;
  const matchableReview = [...matchableA].filter((aRowId) => allCandidateARows.has(aRowId) && !selectedARows.has(aRowId)).length;
  return {
    autoAssignedARows: selectedARows.size,
    autoAssignedPairs,
    trueAutoPairs,
    falseAutoPairs: autoAssignedPairs - trueAutoPairs,
    autoMatchPrecision: finiteRatio(trueAutoPairs, autoAssignedPairs),
    autoMatchRecallPerMatchableARow: trueAutoPairs / Math.max(1, matchableA.size),
    reviewRoutedARows,
    reviewRateAllARows: reviewRoutedARows / Math.max(1, truthA.size),
    reviewRateMatchableARows: matchableReview / Math.max(1, matchableA.size),
    duplicateBClaims: [...claimCounts.values()].reduce((count, n) => count + Math.max(0, n - 1), 0),
  };
}

export interface OneToOneComparison {
  benchmarkVersion: typeof ONE_TO_ONE_BENCHMARK_VERSION;
  denominators: {
    sourceARows: number;
    sourceBRows: number;
    matchableARows: number;
    truthCrossSourcePairs: number;
    retainedCandidatePairs: number;
    retainedTruePairs: number;
    retainedCandidatePairRecall: number;
    aRowsWithRetainedCandidates: number;
    retainedPairReductionFraction: number;
  };
  baseline: AssignmentMetrics;
  oneToOne: AssignmentMetrics;
  delta: {
    autoAssignedARows: number;
    trueAutoPairs: number;
    falseAutoPairs: number;
    reviewRoutedARows: number;
    reviewRateAllARows: number;
    reviewRateMatchableARows: number;
    autoMatchPrecision: number | null;
    duplicateBClaims: number;
  };
  regressionInvariants: {
    uniqueBClaims: true;
    falseAutoPairsDidNotIncrease: true;
    retainedCandidateRecallUnchanged: true;
  };
}

export function analyzeOneToOneImpact(candidates: CandidatePair[], fixture: IdentityTruthFixture): OneToOneComparison {
  const truthA = new Map(fixture.source_a.map((row) => [row.source_row_id, row.canonical_entity_id]));
  const truthB = new Map(fixture.source_b.map((row) => [row.source_row_id, row.canonical_entity_id]));
  if (!truthA.size || !truthB.size || truthA.size !== fixture.source_a.length || truthB.size !== fixture.source_b.length) {
    throw new Error("Truth fixture has missing or duplicate source IDs.");
  }
  const bByEntity = new Map<string, string[]>();
  for (const [rowId, entity] of truthB) {
    const rows = bByEntity.get(entity) ?? [];
    rows.push(rowId);
    bByEntity.set(entity, rows);
  }
  const truthPairs = new Set<string>();
  const matchableA = new Set<string>();
  for (const [aRowId, entity] of truthA) {
    const linkedB = bByEntity.get(entity) ?? [];
    if (linkedB.length) matchableA.add(aRowId);
    for (const bRowId of linkedB) truthPairs.add(`${aRowId}\0${bRowId}`);
  }
  const retainedPairs = new Set<string>();
  const allCandidateARows = new Set<string>();
  for (const candidate of candidates) {
    if (!truthA.has(candidate.aRowId) || !truthB.has(candidate.bRowId)) {
      throw new Error("A matcher candidate references a row outside the held-out fixture.");
    }
    const key = `${candidate.aRowId}\0${candidate.bRowId}`;
    if (retainedPairs.has(key)) throw new Error("Duplicate candidate pairs invalidate the impact comparison.");
    retainedPairs.add(key);
    allCandidateARows.add(candidate.aRowId);
  }
  const retainedTruePairs = [...truthPairs].filter((pair) => retainedPairs.has(pair)).length;
  const baseline = metrics(selectOnePerA(candidates, legacyAutomaticIdentityCandidateIds(candidates)),
    allCandidateARows, truthA, truthB, matchableA);
  const oneToOne = metrics(selectOnePerA(candidates, automaticIdentityCandidateIds(candidates)),
    allCandidateARows, truthA, truthB, matchableA);
  if (oneToOne.duplicateBClaims !== 0 || oneToOne.falseAutoPairs > baseline.falseAutoPairs) {
    throw new Error("One-to-one selector violated the benchmark's safety invariants.");
  }
  return {
    benchmarkVersion: ONE_TO_ONE_BENCHMARK_VERSION,
    denominators: {
      sourceARows: truthA.size,
      sourceBRows: truthB.size,
      matchableARows: matchableA.size,
      truthCrossSourcePairs: truthPairs.size,
      retainedCandidatePairs: retainedPairs.size,
      retainedTruePairs,
      retainedCandidatePairRecall: retainedTruePairs / Math.max(1, truthPairs.size),
      aRowsWithRetainedCandidates: allCandidateARows.size,
      retainedPairReductionFraction: 1 - retainedPairs.size / (truthA.size * truthB.size),
    },
    baseline,
    oneToOne,
    delta: {
      autoAssignedARows: oneToOne.autoAssignedARows - baseline.autoAssignedARows,
      trueAutoPairs: oneToOne.trueAutoPairs - baseline.trueAutoPairs,
      falseAutoPairs: oneToOne.falseAutoPairs - baseline.falseAutoPairs,
      reviewRoutedARows: oneToOne.reviewRoutedARows - baseline.reviewRoutedARows,
      reviewRateAllARows: oneToOne.reviewRateAllARows - baseline.reviewRateAllARows,
      reviewRateMatchableARows: oneToOne.reviewRateMatchableARows - baseline.reviewRateMatchableARows,
      autoMatchPrecision: baseline.autoMatchPrecision === null || oneToOne.autoMatchPrecision === null
        ? null : oneToOne.autoMatchPrecision - baseline.autoMatchPrecision,
      duplicateBClaims: oneToOne.duplicateBClaims - baseline.duplicateBClaims,
    },
    regressionInvariants: {
      uniqueBClaims: true,
      falseAutoPairsDidNotIncrease: true,
      retainedCandidateRecallUnchanged: true,
    },
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Isolated in-process selector timing, not end-to-end matcher latency. */
export function measureSelectionRuntime(candidates: CandidatePair[], repetitions = 51): {
  baselineMedianMs: number;
  oneToOneMedianMs: number;
  repetitions: number;
} {
  if (!Number.isSafeInteger(repetitions) || repetitions < 3 || repetitions > 1001) {
    throw new Error("Choose 3–1001 timing repetitions.");
  }
  const baselineTimes: number[] = [];
  const gatedTimes: number[] = [];
  for (let i = 0; i < repetitions + 5; i += 1) {
    const baselineStart = performance.now();
    legacyAutomaticIdentityCandidateIds(candidates);
    const baselineDuration = performance.now() - baselineStart;
    const gatedStart = performance.now();
    automaticIdentityCandidateIds(candidates);
    const gatedDuration = performance.now() - gatedStart;
    if (i >= 5) {
      baselineTimes.push(baselineDuration);
      gatedTimes.push(gatedDuration);
    }
  }
  return {
    baselineMedianMs: median(baselineTimes),
    oneToOneMedianMs: median(gatedTimes),
    repetitions,
  };
}
