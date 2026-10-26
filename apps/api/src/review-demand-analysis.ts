import { ASSIGNMENT_POLICY_VERSION, type CandidatePair } from "@samewise/contracts";

import { automaticIdentityCandidateIds } from "./identity-selection.js";
import type { VisibleCandidate } from "./e2e-matcher-evaluation.js";
import type { IdentityTruthFixture } from "./one-to-one-benchmark.js";

export const REVIEW_DEMAND_ANALYSIS_VERSION = "review-demand-analysis-v1" as const;

export const REVIEW_CAUSES = [
  "multiple_rank_one_automatic_proposals",
  "matcher_needs_review",
  "matcher_collision_hint",
  "shared_b_candidate",
  "no_rank_one_candidate",
  "other_assignment_guard",
] as const;
export type ReviewCause = (typeof REVIEW_CAUSES)[number];

export const TRUTH_CLASSES = [
  "unique_cross_source_identity",
  "duplicated_cross_source_identity",
  "no_cross_source_identity",
] as const;
export type TruthClass = (typeof TRUTH_CLASSES)[number];

export const TRUTH_EVIDENCE = [
  "top_rank_true",
  "retained_true_alternative",
  "generated_true_not_retained",
  "true_not_generated",
  "no_cross_source_identity",
] as const;
export type TruthEvidence = (typeof TRUTH_EVIDENCE)[number];

function counters<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

/**
 * Observational diagnosis, never an identity decision. The scorer/assignment
 * sees no hidden truth and no per-row ground truth enters the algorithm.
 *
 * Review causes are MUTUALLY EXCLUSIVE. Truth classes and truth-evidence
 * categories are independently labeled; their cross-tabs expose the burden
 * without pretending that a true top-ranked candidate proves safe automation.
 */
export function analyzeReviewDemand(
  truth: IdentityTruthFixture,
  generated: VisibleCandidate[],
  retained: CandidatePair[],
) {
  const aById = new Map(truth.source_a.map(row => [row.source_row_id, row.canonical_entity_id]));
  const bById = new Map(truth.source_b.map(row => [row.source_row_id, row.canonical_entity_id]));
  if (aById.size !== truth.source_a.length || bById.size !== truth.source_b.length) {
    throw new Error("Review demand truth contains duplicate row IDs.");
  }
  const aCountByEntity = new Map<string, number>();
  const bCountByEntity = new Map<string, number>();
  for (const entity of aById.values()) aCountByEntity.set(entity, (aCountByEntity.get(entity) ?? 0) + 1);
  for (const entity of bById.values()) bCountByEntity.set(entity, (bCountByEntity.get(entity) ?? 0) + 1);
  const validPair = (p: VisibleCandidate) => {
    if (!aById.has(p.aRowId) || !bById.has(p.bRowId)) throw new Error("Review demand pair references an unknown source row.");
  };
  generated.forEach(validPair);
  retained.forEach(validPair);

  const generatedByA = new Map<string, Set<string>>();
  for (const pair of generated) {
    const ids = generatedByA.get(pair.aRowId) ?? new Set<string>();
    ids.add(pair.bRowId);
    generatedByA.set(pair.aRowId, ids);
  }
  const retainedByA = new Map<string, CandidatePair[]>();
  const aOwnersByB = new Map<string, Set<string>>();
  for (const pair of retained) {
    const options = retainedByA.get(pair.aRowId) ?? [];
    options.push(pair);
    retainedByA.set(pair.aRowId, options);
    const owners = aOwnersByB.get(pair.bRowId) ?? new Set<string>();
    owners.add(pair.aRowId);
    aOwnersByB.set(pair.bRowId, owners);
  }
  const selected = automaticIdentityCandidateIds(retained);
  const autoARows = new Set(retained.filter(pair => selected.has(pair.candidateId)).map(pair => pair.aRowId));

  const byCause = counters(REVIEW_CAUSES);
  const byTruthClass = counters(TRUTH_CLASSES);
  const byTruthEvidence = counters(TRUTH_EVIDENCE);
  const causeByTruthClass = Object.fromEntries(REVIEW_CAUSES.map(key => [key, counters(TRUTH_CLASSES)])) as Record<ReviewCause, Record<TruthClass, number>>;
  const causeByTruthEvidence = Object.fromEntries(REVIEW_CAUSES.map(key => [key, counters(TRUTH_EVIDENCE)])) as Record<ReviewCause, Record<TruthEvidence, number>>;
  const examplesByCause = Object.fromEntries(REVIEW_CAUSES.map(key => [key, [] as string[]])) as Record<ReviewCause, string[]>;
  const noCandidateByTruthClass = counters(TRUTH_CLASSES);

  const truthClassFor = (aRowId: string): TruthClass => {
    const entity = aById.get(aRowId)!;
    const bCount = bCountByEntity.get(entity) ?? 0;
    if (!bCount) return "no_cross_source_identity";
    if (bCount > 1 || (aCountByEntity.get(entity) ?? 0) > 1) return "duplicated_cross_source_identity";
    return "unique_cross_source_identity";
  };
  const hasTruePair = (aRowId: string, bRowId: string) => aById.get(aRowId) === bById.get(bRowId);
  const hasGeneratedTruePair = (aRowId: string) => {
    const entity = aById.get(aRowId);
    for (const bRowId of generatedByA.get(aRowId) ?? []) {
      if (bById.get(bRowId) === entity) return true;
    }
    return false;
  };
  let reviewed = 0;
  for (const aRowId of aById.keys()) {
    const options = retainedByA.get(aRowId);
    if (!options?.length) {
      noCandidateByTruthClass[truthClassFor(aRowId)] += 1;
      continue;
    }
    if (autoARows.has(aRowId)) continue;
    reviewed += 1;
    const rankOnes = options.filter(pair => pair.rank === 1);
    const top = rankOnes[0];
    let cause: ReviewCause;
    if (rankOnes.length > 1 && rankOnes.some(p => p.band === "auto_match")) {
      cause = "multiple_rank_one_automatic_proposals";
    } else if (!top) {
      cause = "no_rank_one_candidate";
    } else if (top.band === "needs_review") {
      cause = "matcher_needs_review";
    } else if (top.collision) {
      cause = "matcher_collision_hint";
    } else if ((aOwnersByB.get(top.bRowId)?.size ?? 0) > 1) {
      cause = "shared_b_candidate";
    } else {
      cause = "other_assignment_guard";
    }
    const entity = aById.get(aRowId)!;
    const crossSourceTrue = (bCountByEntity.get(entity) ?? 0) > 0;
    let evidence: TruthEvidence;
    if (!crossSourceTrue) evidence = "no_cross_source_identity";
    else if (top && hasTruePair(aRowId, top.bRowId)) evidence = "top_rank_true";
    else if (options.some(pair => hasTruePair(aRowId, pair.bRowId))) evidence = "retained_true_alternative";
    else if (hasGeneratedTruePair(aRowId)) evidence = "generated_true_not_retained";
    else evidence = "true_not_generated";
    const truthClass = truthClassFor(aRowId);
    byCause[cause] += 1;
    byTruthClass[truthClass] += 1;
    byTruthEvidence[evidence] += 1;
    causeByTruthClass[cause][truthClass] += 1;
    causeByTruthEvidence[cause][evidence] += 1;
    if (examplesByCause[cause].length < 5) examplesByCause[cause].push(aRowId);
  }
  const totalByCause = Object.values(byCause).reduce((s, v) => s + v, 0);
  const totalByTruthClass = Object.values(byTruthClass).reduce((s, v) => s + v, 0);
  const totalByTruthEvidence = Object.values(byTruthEvidence).reduce((s, v) => s + v, 0);
  if (reviewed !== totalByCause || reviewed !== totalByTruthClass || reviewed !== totalByTruthEvidence
    || reviewed + autoARows.size !== retainedByA.size) {
    throw new Error("Review demand decomposition did not reconcile.");
  }
  const truthRelevantA = [...aById.keys()].filter(id => truthClassFor(id) !== "no_cross_source_identity");
  return {
    analysisVersion: REVIEW_DEMAND_ANALYSIS_VERSION,
    assignmentPolicy: ASSIGNMENT_POLICY_VERSION,
    scope: "Existing scored retained candidates; no policy changes or human simulation.",
    denominators: {
      sourceARows: aById.size,
      candidateBearingARows: retainedByA.size,
      automaticARows: autoARows.size,
      reviewRoutedARows: reviewed,
      matchableARows: truthRelevantA.length,
      noRetainedCandidateARows: aById.size - retainedByA.size,
    },
    reviewedByCause: byCause,
    reviewedByTruthClass: byTruthClass,
    reviewedByTruthEvidence: byTruthEvidence,
    causeByTruthClass,
    causeByTruthEvidence,
    noCandidateByTruthClass,
    examplesByCause,
    caveats: [
      "Ground truth diagnoses review demand after matching; it is never passed to the matcher.",
      "Top-ranked truth and duplicate labels are retrospective oracle evidence, not proof an automatic decision would be safe.",
      "Review causes are priority-ordered mutually exclusive categories; a candidate may have multiple contributing properties.",
      "Duplicated identity means more than one A or B row shares a canonical entity; it does not imply one-to-one links are valid for every occurrence.",
    ],
    invariants: {
      reviewCausesReconcile: true,
      truthClassCountsReconcile: true,
      truthEvidenceCountsReconcile: true,
    },
  };
}
