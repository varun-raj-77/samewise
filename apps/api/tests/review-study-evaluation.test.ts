import { describe, expect, it } from "vitest";

import { evaluateReviewStudy, REVIEW_STUDY_VERSION } from "../src/review-study-evaluation.js";

function sample() {
  return {
    studyVersion: REVIEW_STUDY_VERSION,
    taskSetId: "synthetic-collision-tasks-v1",
    truth: [
      { caseId: "case-1", expectedDecision: "same_entity" },
      { caseId: "case-2", expectedDecision: "different_entity" },
      { caseId: "case-3", expectedDecision: "same_entity" },
    ],
    sessions: [
      {
        sessionId: "session-standard", reviewerId: "reviewer-pseudonym-1",
        taskSetId: "synthetic-collision-tasks-v1", arm: "standard_queue",
        events: [
          { atMs: 0, caseId: "case-1", action: "open_case" },
          { atMs: 10, caseId: "case-1", action: "inspect_candidate" },
          { atMs: 25, caseId: "case-1", action: "record_decision", decision: "same_entity" },
          { atMs: 30, caseId: "case-2", action: "open_case" },
          { atMs: 50, caseId: "case-2", action: "record_decision", decision: "same_entity" },
          { atMs: 55, caseId: "case-3", action: "open_case" },
          { atMs: 65, caseId: "case-3", action: "skip_case" },
        ],
      },
      {
        sessionId: "session-collision", reviewerId: "reviewer-pseudonym-2",
        taskSetId: "synthetic-collision-tasks-v1", arm: "collision_inspector",
        events: [
          { atMs: 0, caseId: "case-1", action: "open_case" },
          { atMs: 5, caseId: "case-1", action: "open_collision" },
          { atMs: 12, caseId: "case-1", action: "inspect_candidate" },
          { atMs: 20, caseId: "case-1", action: "record_decision", decision: "same_entity" },
          { atMs: 25, caseId: "case-2", action: "open_case" },
          { atMs: 30, caseId: "case-2", action: "open_collision" },
          { atMs: 40, caseId: "case-2", action: "record_decision", decision: "different_entity" },
          { atMs: 45, caseId: "case-3", action: "open_case" },
          { atMs: 55, caseId: "case-3", action: "record_decision", decision: "different_entity" },
        ],
      },
    ],
  };
}

function changeFirstEvent(changes: Record<string, unknown>, atIndex: number) {
  const source = sample();
  return { ...source, sessions: [
    { ...source.sessions[0]!, events: source.sessions[0]!.events.map((event, i) =>
      i === atIndex ? { ...event, ...changes } : event) },
    source.sessions[1],
  ] };
}

describe("SW-029 offline reviewer-efficiency evaluation", () => {
  it("derives error types, denominators, skip rate, median case time and navigation only from observed events", () => {
    const result = evaluateReviewStudy(sample());
    expect(result).toMatchObject({
      analysisVersion: REVIEW_STUDY_VERSION, taskSetId: "synthetic-collision-tasks-v1",
      labeledCases: 3, hasRecordedSessions: true, sameCaseCoverageAcrossArms: true,
    });
    expect(result.arms[0]).toMatchObject({
      arm: "standard_queue", sessions: 1, reviewers: 1,
      uniqueCasesSeen: 3, casesObserved: 3, decisions: 2, skipped: 1,
      correct: 1, falsePositive: 1, falseNegative: 0, accuracy: 0.5,
      medianDecisionMs: 22.5, navigationActionsOnDecidedCases: 1,
      navigationActionsPerDecision: 0.5,
    });
    expect(result.arms[1]).toMatchObject({
      arm: "collision_inspector", sessions: 1, reviewers: 1,
      casesObserved: 3, decisions: 3, skipped: 0,
      correct: 2, falsePositive: 0, falseNegative: 1, accuracy: 2 / 3,
      medianDecisionMs: 15, navigationActionsOnDecidedCases: 3,
      navigationActionsPerDecision: 1,
    });
    expect(result.interpretation).toMatch(/No causal speedup/);
  });

  it("returns null instead of invented metrics when there are no recorded sessions", () => {
    const source = sample();
    const result = evaluateReviewStudy({ ...source, sessions: [] });
    expect(result.sameCaseCoverageAcrossArms).toBe(false);
    expect(result.hasRecordedSessions).toBe(false);
    for (const arm of result.arms) {
      expect(arm).toMatchObject({
        sessions: 0, reviewers: 0, casesObserved: 0, decisions: 0, skipped: 0,
        falsePositive: 0, falseNegative: 0, accuracy: null,
        medianDecisionMs: null, navigationActionsPerDecision: null,
      });
    }
  });

  it("rejects duplicated truth, unknown cases and mismatched task versions", () => {
    const source = sample();
    expect(() => evaluateReviewStudy({ ...source, truth: [...source.truth, source.truth[0]] }))
      .toThrow(/Duplicate truth case/);
    expect(() => evaluateReviewStudy(changeFirstEvent({ caseId: "unknown" }, 0)))
      .toThrow(/unlabeled case/);
    expect(() => evaluateReviewStudy({ ...source, sessions: [
      { ...source.sessions[0], taskSetId: "different-task-set" },
    ] })).toThrow(/task set differs/);
  });

  it("rejects nonmonotonic, negative, fractional and nonfinite clocks", () => {
    for (const atMs of [-1, 0.25, Number.POSITIVE_INFINITY]) {
      expect(() => evaluateReviewStudy(changeFirstEvent({ atMs }, 1)))
        .toThrow(/monotonic nonnegative integer/);
    }
    expect(() => evaluateReviewStudy(changeFirstEvent({ atMs: 26 }, 1)))
      .toThrow(/monotonic nonnegative integer/);
  });

  it("rejects double-decisions, unclosed cases, and actions before case selection", () => {
    expect(() => evaluateReviewStudy(changeFirstEvent({ action: "record_decision", decision: "same_entity" }, 0)))
      .toThrow(/currently open case/);
    expect(() => evaluateReviewStudy(changeFirstEvent({ action: "open_case" }, 1)))
      .toThrow(/sequentially/);
    expect(() => evaluateReviewStudy(changeFirstEvent({ caseId: "case-2" }, 1)))
      .toThrow(/currently open case/);
    const source = sample();
    expect(() => evaluateReviewStudy({ ...source, sessions: [
      { ...source.sessions[0], events: source.sessions[0]!.events.slice(0, 2) },
    ] })).toThrow(/unclosed case/);
  });

  it("rejects invalid decision payloads and arm-specific actions", () => {
    expect(() => evaluateReviewStudy(changeFirstEvent({ action: "open_collision" }, 1)))
      .toThrow(/standard queue arm/);
    expect(() => evaluateReviewStudy(changeFirstEvent({ decision: "same_entity" }, 1)))
      .toThrow(/Only a decision event/);
    expect(() => evaluateReviewStudy(changeFirstEvent({ decision: "unknown" }, 2)))
      .toThrow(/SAME or DIFFERENT/);
  });

  it("keeps reviewer traces free of source-row fields and never mutates input", () => {
    expect(() => evaluateReviewStudy(changeFirstEvent({ rawRecord: "secret" }, 1)))
      .toThrow(/unsupported field rawRecord/);
    const source = sample();
    const before = JSON.stringify(source);
    const first = evaluateReviewStudy(source);
    const second = evaluateReviewStudy(source);
    expect(JSON.stringify(source)).toBe(before);
    expect(second).toEqual(first);
  });

  it("does not imply fair arm comparison when each arm saw different tasks", () => {
    const source = sample();
    const result = evaluateReviewStudy({ ...source, sessions: [
      source.sessions[0],
      { ...source.sessions[1], events: source.sessions[1]!.events.slice(0, 7) },
    ] });
    expect(result.sameCaseCoverageAcrossArms).toBe(false);
    expect(result.arms[1]?.casesObserved).toBe(2);
  });
});
