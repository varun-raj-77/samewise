export const REVIEW_STUDY_VERSION = "review-study-v1.0.0" as const;

export type ReviewDecision = "same_entity" | "different_entity";
export type ReviewArm = "standard_queue" | "collision_inspector";
export type ReviewEventAction =
  | "open_case" | "inspect_candidate" | "open_collision" | "record_decision" | "skip_case";

interface ScoredCase {
  caseId: string;
  truth: ReviewDecision;
}

interface ObservedCase {
  caseId: string;
  decision: ReviewDecision | null;
  durationMs: number;
  navigationActions: number;
}

interface SessionResult {
  arm: ReviewArm;
  reviewerId: string;
  cases: ObservedCase[];
}

const ARMS: readonly ReviewArm[] = ["standard_queue", "collision_inspector"];
const ACTIONS: readonly ReviewEventAction[] = [
  "open_case", "inspect_candidate", "open_collision", "record_decision", "skip_case",
];

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(context + " must be an object.");
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(context + " includes unsupported field " + key + ".");
  }
}

function identifier(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 200) {
    throw new Error(context + " must be a nonempty bounded identifier.");
  }
  return value;
}

function decision(value: unknown, context: string): ReviewDecision {
  if (value !== "same_entity" && value !== "different_entity") {
    throw new Error(context + " must be SAME or DIFFERENT.");
  }
  return value;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Score recorded human review traces only AFTER truth is revealed to the
 * evaluator. No synthetic reviewer behavior, matcher tuning or product
 * identity decision is produced by this function.
 *
 * All timing is relative to the session clock and is observational; it
 * includes any pauses during a case. Cases must be worked sequentially.
 */
export function evaluateReviewStudy(input: unknown) {
  const study = record(input, "Study");
  onlyKeys(study, ["studyVersion", "taskSetId", "truth", "sessions"], "Study");
  if (study.studyVersion !== REVIEW_STUDY_VERSION) throw new Error("Unsupported review study version.");
  const taskSetId = identifier(study.taskSetId, "Task set ID");
  if (!Array.isArray(study.truth) || study.truth.length === 0) throw new Error("Study truth must contain labeled cases.");
  if (!Array.isArray(study.sessions)) throw new Error("Study sessions must be an array.");

  const truth = new Map<string, ScoredCase>();
  for (const [i, raw] of study.truth.entries()) {
    const item = record(raw, "Truth case " + i);
    onlyKeys(item, ["caseId", "expectedDecision"], "Truth case " + i);
    const caseId = identifier(item.caseId, "Truth case ID");
    if (truth.has(caseId)) throw new Error("Duplicate truth case " + caseId + ".");
    truth.set(caseId, { caseId, truth: decision(item.expectedDecision, "Truth label") });
  }

  const sessionIds = new Set<string>();
  const sessions: SessionResult[] = [];
  for (const [i, raw] of study.sessions.entries()) {
    const item = record(raw, "Session " + i);
    onlyKeys(item, ["sessionId", "reviewerId", "taskSetId", "arm", "events"], "Session " + i);
    const sessionId = identifier(item.sessionId, "Session ID");
    const reviewerId = identifier(item.reviewerId, "Pseudonymous reviewer ID");
    if (sessionIds.has(sessionId)) throw new Error("Duplicate session ID " + sessionId + ".");
    sessionIds.add(sessionId);
    if (item.taskSetId !== taskSetId) throw new Error("Session task set differs from study truth.");
    if (!ARMS.includes(item.arm as ReviewArm)) throw new Error("Unknown review study arm.");
    const arm = item.arm as ReviewArm;
    if (!Array.isArray(item.events)) throw new Error("Session events must be an array.");

    const cases: ObservedCase[] = [];
    const visited = new Set<string>();
    let active: { caseId: string; openedMs: number; navigationActions: number } | null = null;
    let previousTime = -1;
    for (const [eventIndex, eventRaw] of item.events.entries()) {
      const event = record(eventRaw, "Event " + eventIndex);
      onlyKeys(event, ["atMs", "caseId", "action", "decision"], "Event " + eventIndex);
      const caseId = identifier(event.caseId, "Event case ID");
      if (!truth.has(caseId)) throw new Error("Event references unlabeled case " + caseId + ".");
      const atMs = event.atMs;
      if (typeof atMs !== "number" || !Number.isSafeInteger(atMs) || atMs < 0 || atMs < previousTime) {
        throw new Error("Event time must be a monotonic nonnegative integer in milliseconds.");
      }
      previousTime = atMs;
      if (!ACTIONS.includes(event.action as ReviewEventAction)) throw new Error("Unknown review event action.");
      const action = event.action as ReviewEventAction;
      if (action === "record_decision") decision(event.decision, "Recorded decision");
      else if (event.decision !== undefined) throw new Error("Only a decision event can contain a decision.");

      if (action === "open_case") {
        if (active) throw new Error("Review cases must be opened and closed sequentially.");
        if (visited.has(caseId)) throw new Error("A session cannot revisit a completed case.");
        visited.add(caseId);
        active = { caseId, openedMs: atMs, navigationActions: 0 };
        continue;
      }
      if (!active || active.caseId !== caseId) throw new Error("An action requires the currently open case.");
      if (action === "open_collision" && arm !== "collision_inspector") {
        throw new Error("The standard queue arm cannot record collision inspector opens.");
      }
      if (action === "inspect_candidate" || action === "open_collision") {
        active.navigationActions += 1;
        continue;
      }
      cases.push({
        caseId,
        decision: action === "record_decision" ? decision(event.decision, "Recorded decision") : null,
        durationMs: atMs - active.openedMs,
        navigationActions: active.navigationActions,
      });
      active = null;
    }
    if (active) throw new Error("A session contains an unclosed case.");
    sessions.push({ arm, reviewerId, cases });
  }

  const byArm = ARMS.map((arm) => {
    const armSessions = sessions.filter((session) => session.arm === arm);
    const cases = armSessions.flatMap((session) => session.cases);
    const completed = cases.filter((item) => item.decision !== null);
    const falsePositive = completed.filter((item) =>
      item.decision === "same_entity" && truth.get(item.caseId)!.truth === "different_entity").length;
    const falseNegative = completed.filter((item) =>
      item.decision === "different_entity" && truth.get(item.caseId)!.truth === "same_entity").length;
    const correct = completed.length - falsePositive - falseNegative;
    const navigationActions = completed.reduce((sum, item) => sum + item.navigationActions, 0);
    return {
      arm,
      sessions: armSessions.length,
      reviewers: new Set(armSessions.map((session) => session.reviewerId)).size,
      uniqueCasesSeen: new Set(cases.map((item) => item.caseId)).size,
      casesObserved: cases.length,
      decisions: completed.length,
      skipped: cases.length - completed.length,
      correct,
      falsePositive,
      falseNegative,
      accuracy: completed.length ? correct / completed.length : null,
      medianDecisionMs: median(completed.map((item) => item.durationMs)),
      navigationActionsOnDecidedCases: navigationActions,
      navigationActionsPerDecision: completed.length ? navigationActions / completed.length : null,
    };
  });

  const casesForArm = (arm: ReviewArm) => new Set(sessions.filter((session) =>
    session.arm === arm).flatMap((session) => session.cases.map((item) => item.caseId)));
  const standardCases = casesForArm("standard_queue");
  const collisionCases = casesForArm("collision_inspector");
  const sameCaseCoverage = standardCases.size > 0 && collisionCases.size > 0
    && standardCases.size === collisionCases.size
    && [...standardCases].every((caseId) => collisionCases.has(caseId));

  return {
    analysisVersion: REVIEW_STUDY_VERSION,
    taskSetId,
    labeledCases: truth.size,
    hasRecordedSessions: sessions.length > 0,
    arms: byArm,
    sameCaseCoverageAcrossArms: sameCaseCoverage,
    interpretation: "Descriptive observations only. No causal speedup or accuracy claim is supported without controlled assignment and representative reviewers.",
    privacyBoundary: "Only pseudonymous reviewer IDs, case IDs, action types and relative elapsed times; never source fields or hidden labels in review events.",
  };
}
