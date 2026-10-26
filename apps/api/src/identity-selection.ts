import type { CandidatePair } from "@samewise/contracts";

/**
 * Each persisted run pins its assignment semantics separately from matcher
 * scoring. This is the only supported live version; unknown future/legacy
 * versions must not be reinterpreted as the current selector.
 */
export const ASSIGNMENT_POLICY_VERSION = "assignment-one-to-one-conservative-v1" as const;
export type AssignmentPolicyVersion = typeof ASSIGNMENT_POLICY_VERSION;

export function automaticCandidatesForPolicy(
  candidates: CandidatePair[],
  policyVersion: string,
): Set<string> {
  if (policyVersion !== ASSIGNMENT_POLICY_VERSION) {
    throw new Error("Unsupported historical identity-assignment policy version.");
  }
  return automaticIdentityCandidateIds(candidates);
}

/**
 * SW-021's product selector: a scored pair is not a global assignment.
 * Every retained candidate is considered when detecting B-side competition.
 * This module is imported by both the live product and SW-022 benchmark so
 * measured behavior cannot silently diverge from production logic.
 */
export function automaticIdentityCandidateIds(candidates: CandidatePair[]): Set<string> {
  const ownersByB = new Map<string, Set<string>>();
  const automaticByA = new Map<string, number>();
  for (const candidate of candidates) {
    const owners = ownersByB.get(candidate.bRowId) ?? new Set<string>();
    owners.add(candidate.aRowId);
    ownersByB.set(candidate.bRowId, owners);
    if (candidate.rank === 1 && candidate.band === "auto_match") {
      automaticByA.set(candidate.aRowId, (automaticByA.get(candidate.aRowId) ?? 0) + 1);
    }
  }
  return new Set(candidates.filter((candidate) =>
    candidate.rank === 1
    && candidate.band === "auto_match"
    && !candidate.collision
    && ownersByB.get(candidate.bRowId)?.size === 1
    && automaticByA.get(candidate.aRowId) === 1
  ).map((candidate) => candidate.candidateId));
}

/** Frozen pre-SW-021 predicate; comparison only, never used by product. */
export function legacyAutomaticIdentityCandidateIds(candidates: CandidatePair[]): Set<string> {
  return new Set(candidates.filter((candidate) =>
    candidate.rank === 1 && candidate.band === "auto_match"
  ).map((candidate) => candidate.candidateId));
}
