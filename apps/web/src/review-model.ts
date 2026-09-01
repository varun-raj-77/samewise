import type { CandidatePair, ReviewQueueItem, RunView } from "@samewise/contracts";

export type ReviewFilter = "unresolved" | "all" | "deferred" | "collision" | "contradiction" | "multiple";
export type ReviewSort = "ambiguity" | "score_desc" | "score_asc" | "candidate_count" | "source";

export function candidateOptions(run: RunView, item: ReviewQueueItem): CandidatePair[] {
  const ids = new Set(item.candidateIds);
  return run.candidates
    .filter((candidate) => ids.has(candidate.candidateId))
    .sort((left, right) => left.rank - right.rank || left.candidateId.localeCompare(right.candidateId));
}

export function reviewItems(
  run: RunView,
  filter: ReviewFilter,
  sort: ReviewSort,
  query: string,
): ReviewQueueItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = run.reviewQueue.filter((item) => {
    if (filter === "unresolved" && item.state !== "needs_review") return false;
    if (filter === "deferred" && item.state !== "deferred") return false;
    if (filter === "collision" && !item.collision) return false;
    if (filter === "contradiction" && !item.strongContradiction && !item.strongestContradiction) return false;
    if (filter === "multiple" && item.candidateCount <= 1) return false;
    if (!normalizedQuery) return true;
    const top = run.candidates.find((candidate) => candidate.candidateId === item.topCandidateId);
    const nameEvidence = top?.evidence.find((evidence) => evidence.fieldKind === "name");
    return [item.aRowId, item.topBRowId, nameEvidence?.aValue, nameEvidence?.bValue]
      .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
  });
  return [...filtered].sort((left, right) => {
    if (sort === "ambiguity") return left.runnerUpMargin - right.runnerUpMargin || right.topMatchScore - left.topMatchScore || left.sourceOrder - right.sourceOrder;
    if (sort === "score_desc") return right.topMatchScore - left.topMatchScore || left.sourceOrder - right.sourceOrder;
    if (sort === "score_asc") return left.topMatchScore - right.topMatchScore || left.sourceOrder - right.sourceOrder;
    if (sort === "candidate_count") return right.candidateCount - left.candidateCount || left.sourceOrder - right.sourceOrder;
    return left.sourceOrder - right.sourceOrder;
  });
}

export function evidenceStateLabel(candidate: CandidatePair, mappingId: string): string {
  const evidence = candidate.evidence.find((item) => item.mappingId === mappingId);
  if (!evidence) return "Evidence unavailable";
  if (evidence.evidenceClass === "exact_agreement") return "Exact";
  if (evidence.evidenceClass === "partial_agreement") {
    const strongestFeature = Math.max(0, ...evidence.features.map((feature) => feature.value));
    return strongestFeature >= 0.85 ? "Strong agreement" : "Partial agreement";
  }
  if (evidence.evidenceClass === "conflict") return "Conflict";
  if (evidence.evidenceClass === "missing_left") return "Missing A";
  if (evidence.evidenceClass === "missing_right") return "Missing B";
  return "Missing both";
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches("input, textarea, select, [contenteditable='true']") || !!target.closest("[contenteditable='true']");
}

export function effectiveLinkForB(run: RunView, bRowId: string): CandidatePair[] {
  const humanSameIds = new Set(run.decisions.filter((decision) => decision.humanDecision === "same_entity").map((decision) => decision.candidateId));
  const humanSameA = new Set(run.decisions.filter((decision) => decision.humanDecision === "same_entity").map((decision) => decision.aRowId));
  const rejectedIds = new Set(run.decisions.filter((decision) => decision.humanDecision === "different_entity").map((decision) => decision.candidateId));
  return run.candidates.filter((candidate) => candidate.bRowId === bRowId && (
    humanSameIds.has(candidate.candidateId)
    || (candidate.rank === 1 && candidate.band === "auto_match" && !humanSameA.has(candidate.aRowId) && !rejectedIds.has(candidate.candidateId))
  ));
}
