import type { CandidatePair } from "@samewise/contracts";

/**
 * Frozen SW-021 conservative selector. Keep it available for the unchanged
 * SW-022 comparison; it is no longer the production policy.
 */
export function conservativeAutomaticIdentityCandidateIds(candidates: CandidatePair[]): Set<string> {
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

/**
 * SW-023: deterministic constraint propagation, not a greedy maximum-weight
 * assignment. An A can be safely removed as a competing potential owner of B
 * only when it has already been assigned elsewhere by an uncontested link.
 *
 * Examples:
 *   A1->B1 auto, A2->B2 auto, A2->B1 alternate:
 *     anchor A2->B2 first, then release A1->B1.
 *   A1->B1 auto, A2->B1 auto:
 *     neither can be assigned; both require review.
 *   A1->B1 auto, A2->B2 auto, reciprocal alternates:
 *     no unambiguous anchor; both require review.
 *
 * The matcher scores, raw collision flags, and candidate evidence are never
 * changed. Only eligible auto proposals can be promoted. Every accepted A
 * and B appears at most once. Human decisions remain authoritative elsewhere.
 */
export function automaticIdentityCandidateIds(candidates: CandidatePair[]): Set<string> {
  const ownerARowsByB = new Map<string, Set<string>>();
  const candidateBsByA = new Map<string, Set<string>>();
  const autoProposalsByA = new Map<string, CandidatePair[]>();
  for (const candidate of candidates) {
    const owners = ownerARowsByB.get(candidate.bRowId) ?? new Set<string>();
    owners.add(candidate.aRowId);
    ownerARowsByB.set(candidate.bRowId, owners);
    const bs = candidateBsByA.get(candidate.aRowId) ?? new Set<string>();
    bs.add(candidate.bRowId);
    candidateBsByA.set(candidate.aRowId, bs);
    if (candidate.rank === 1 && candidate.band === "auto_match") {
      const auto = autoProposalsByA.get(candidate.aRowId) ?? [];
      auto.push(candidate);
      autoProposalsByA.set(candidate.aRowId, auto);
    }
  }

  const candidatesByB = new Map<string, CandidatePair[]>();
  for (const proposed of autoProposalsByA.values()) {
    // Preserve SW-021's fail-closed handling of malformed duplicate rank 1
    // and explicit matcher collision flags.
    if (proposed.length !== 1 || proposed[0]!.collision) continue;
    const candidate = proposed[0]!;
    const byB = candidatesByB.get(candidate.bRowId) ?? [];
    byB.push(candidate);
    candidatesByB.set(candidate.bRowId, byB);
  }

  const unresolvedOwnerCount = new Map(
    [...ownerARowsByB].map(([bRowId, owners]) => [bRowId, owners.size]),
  );
  const selectedIds = new Set<string>();
  const assignedA = new Set<string>();
  const assignedB = new Set<string>();
  const work: CandidatePair[] = [];
  for (const [bRowId, proposed] of candidatesByB) {
    if (unresolvedOwnerCount.get(bRowId) === 1) work.push(...proposed);
  }

  for (let i = 0; i < work.length; i += 1) {
    const candidate = work[i]!;
    if (assignedA.has(candidate.aRowId) || assignedB.has(candidate.bRowId)
      || unresolvedOwnerCount.get(candidate.bRowId) !== 1) continue;

    assignedA.add(candidate.aRowId);
    assignedB.add(candidate.bRowId);
    selectedIds.add(candidate.candidateId);

    // Once A is anchored to B, its alternatives cannot *also* claim any B.
    // Decrement each distinct B exactly once; the graph never grows here.
    for (const bRowId of candidateBsByA.get(candidate.aRowId) ?? []) {
      if (bRowId === candidate.bRowId) continue;
      const remaining = unresolvedOwnerCount.get(bRowId);
      if (remaining === undefined || remaining <= 0) continue;
      unresolvedOwnerCount.set(bRowId, remaining - 1);
      if (remaining === 2) work.push(...(candidatesByB.get(bRowId) ?? []));
    }
  }
  return selectedIds;
}

/** Frozen pre-SW-021 predicate; historical comparison only. */
export function legacyAutomaticIdentityCandidateIds(candidates: CandidatePair[]): Set<string> {
  return new Set(candidates.filter((candidate) =>
    candidate.rank === 1 && candidate.band === "auto_match"
  ).map((candidate) => candidate.candidateId));
}
