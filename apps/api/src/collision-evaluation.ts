import {
  ASSIGNMENT_POLICY_VERSION,
  COLLISION_EVALUATION_VERSION,
  CollisionScenarioCatalogSchema,
  type CandidatePair,
} from "@samewise/contracts";

export { COLLISION_EVALUATION_VERSION, CollisionScenarioCatalogSchema } from "@samewise/contracts";

import { analyzeOneToOneImpact, type AssignmentMetrics } from "./one-to-one-benchmark.js";

function sumMetrics(a: AssignmentMetrics, b: AssignmentMetrics): AssignmentMetrics {
  // Weighted aggregate is computed separately, not by averaging per-case
  // percentages. Placeholder rate fields are recomputed from true counts.
  return {
    ...a,
    autoAssignedARows: a.autoAssignedARows + b.autoAssignedARows,
    autoAssignedPairs: a.autoAssignedPairs + b.autoAssignedPairs,
    trueAutoPairs: a.trueAutoPairs + b.trueAutoPairs,
    falseAutoPairs: a.falseAutoPairs + b.falseAutoPairs,
    reviewRoutedARows: a.reviewRoutedARows + b.reviewRoutedARows,
    duplicateBClaims: a.duplicateBClaims + b.duplicateBClaims,
  };
}

function precision(truePairs: number, assignedPairs: number): number | null {
  return assignedPairs ? truePairs / assignedPairs : null;
}

function validateUnique(items: readonly string[], description: string): void {
  if (new Set(items).size !== items.length) {
    throw new Error(`Fixture has duplicate ${description}.`);
  }
}

export function evaluateCollisionCatalog(source: unknown) {
  const catalog = CollisionScenarioCatalogSchema.parse(source);
  validateUnique(catalog.cases.map((item) => item.id), "scenario IDs");
  const cases = catalog.cases.map((scenario) => {
    validateUnique(scenario.sourceA.map((item) => item.rowId), `${scenario.id} A row IDs`);
    validateUnique(scenario.sourceB.map((item) => item.rowId), `${scenario.id} B row IDs`);
    validateUnique(scenario.candidates.map((item) => item.candidateId), `${scenario.id} candidate IDs`);
    // No scores or records are fabricated for these scenarios. Both selector
    // functions consume only the fields defined by CandidateEdgeSchema.
    const candidates = scenario.candidates as unknown as CandidatePair[];
    const comparison = analyzeOneToOneImpact(candidates, {
      source_a: scenario.sourceA.map((item) => ({
        source_row_id: item.rowId, canonical_entity_id: item.entityId,
      })),
      source_b: scenario.sourceB.map((item) => ({
        source_row_id: item.rowId, canonical_entity_id: item.entityId,
      })),
    });
    return {
      id: scenario.id,
      description: scenario.description,
      denominators: comparison.denominators,
      legacy: comparison.baseline,
      conservative: comparison.oneToOne,
      delta: comparison.delta,
      outcomes: {
        duplicateBClaimsEliminated: comparison.baseline.duplicateBClaims - comparison.oneToOne.duplicateBClaims,
        correctAutomaticLinksDeferred: Math.max(0, comparison.baseline.trueAutoPairs - comparison.oneToOne.trueAutoPairs),
        falseAutomaticLinksDeferred: Math.max(0, comparison.baseline.falseAutoPairs - comparison.oneToOne.falseAutoPairs),
      },
    };
  });
  const all = cases[0]!;
  const aggregate = cases.slice(1).reduce((totals, item) => ({
    legacy: sumMetrics(totals.legacy, item.legacy),
    conservative: sumMetrics(totals.conservative, item.conservative),
    sourceARows: totals.sourceARows + item.denominators.sourceARows,
    sourceBRows: totals.sourceBRows + item.denominators.sourceBRows,
    trueCrossSourcePairs: totals.trueCrossSourcePairs + item.denominators.truthCrossSourcePairs,
    retainedTruePairs: totals.retainedTruePairs + item.denominators.retainedTruePairs,
  }), {
    legacy: all.legacy,
    conservative: all.conservative,
    sourceARows: all.denominators.sourceARows,
    sourceBRows: all.denominators.sourceBRows,
    trueCrossSourcePairs: all.denominators.truthCrossSourcePairs,
    retainedTruePairs: all.denominators.retainedTruePairs,
  });
  return {
    evaluationVersion: COLLISION_EVALUATION_VERSION,
    fixtureOrigin: catalog.origin,
    scope: "Hand-authored synthetic candidate graphs only. Not a matcher quality or production precision benchmark.",
    scenarioCount: cases.length,
    policyVersion: ASSIGNMENT_POLICY_VERSION,
    cases,
    aggregate: {
      sourceARows: aggregate.sourceARows,
      sourceBRows: aggregate.sourceBRows,
      truthCrossSourcePairs: aggregate.trueCrossSourcePairs,
      retainedTruePairs: aggregate.retainedTruePairs,
      retainedCandidatePairRecall: aggregate.trueCrossSourcePairs
        ? aggregate.retainedTruePairs / aggregate.trueCrossSourcePairs : null,
      legacy: {
        autoAssignedPairs: aggregate.legacy.autoAssignedPairs,
        trueAutoPairs: aggregate.legacy.trueAutoPairs,
        falseAutoPairs: aggregate.legacy.falseAutoPairs,
        precision: precision(aggregate.legacy.trueAutoPairs, aggregate.legacy.autoAssignedPairs),
        reviewRoutedARows: aggregate.legacy.reviewRoutedARows,
        duplicateBClaims: aggregate.legacy.duplicateBClaims,
      },
      conservative: {
        autoAssignedPairs: aggregate.conservative.autoAssignedPairs,
        trueAutoPairs: aggregate.conservative.trueAutoPairs,
        falseAutoPairs: aggregate.conservative.falseAutoPairs,
        precision: precision(aggregate.conservative.trueAutoPairs, aggregate.conservative.autoAssignedPairs),
        reviewRoutedARows: aggregate.conservative.reviewRoutedARows,
        duplicateBClaims: aggregate.conservative.duplicateBClaims,
      },
    },
  };
}
