import { describe, expect, it } from "vitest";

import type { CandidatePair, ReviewQueueItem, RunView } from "@samewise/contracts";
import { evidenceStateLabel, reviewItems } from "./review-model.js";

function candidate(evidenceClass: CandidatePair["evidence"][number]["evidenceClass"] = "missing_left"): CandidatePair {
  return {
    candidateId: "c1", aRowId: "A1", bRowId: "B1", aRecord: { name: "Acme" }, bRecord: { organization: "Acme Co" },
    rank: 1, matchScore: 0.4, runnerUpMargin: 0.01, band: "needs_review", collision: false, strongContradiction: false,
    blockingEvidence: [{ blockerId: "name", keyHash: "0123456789abcdef" }], positiveEvidence: 0, conflictEvidence: 0, totalWeight: 1,
    evidence: [{ mappingId: "name", label: "Name", aColumn: "name", bColumn: "organization", aValue: "", bValue: "Acme Co", normalizedA: "", normalizedB: "acme co", fieldKind: "name", featurePipelineVersion: "feature-pipeline-v0.1.0", features: [], outcome: "missing_one", evidenceClass, weight: 1, positiveContribution: 0, conflictContribution: 0, contribution: 0, explanationCode: "missing", explanation: "One mapped value is missing." }],
  };
}

function queue(index: number, overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    aRowId: `A${index}`, candidateIds: [`c${index}`], topCandidateId: `c${index}`, topBRowId: `B${index}`,
    topMatchScore: 0.4 + index / 100, runnerUpMargin: index / 100, candidateCount: 1,
    strongestPositive: null, strongestContradiction: null, collision: false, collisionARowIds: [], strongContradiction: false,
    state: "needs_review", deferred: false, humanDecision: null, matcherVersion: "explainable-matcher-v0.2.0", sourceOrder: index,
    ...overrides,
  };
}

function runView(reviewQueue: ReviewQueueItem[]): RunView {
  const first = candidate();
  return {
    contractVersion: "1.0.0", runId: "run", stage: "review", datasets: {}, mappings: [], mappingVersion: "confirmed-mappings-v1", semanticMappingProvenance: null,
    matcherVersion: "explainable-matcher-v0.2.0", matcherProvenance: null, summary: { matched: 0, needsReview: reviewQueue.length, onlyA: 0, onlyB: 0 },
    candidates: reviewQueue.map((item, index) => ({ ...first, candidateId: item.topCandidateId, aRowId: item.aRowId, bRowId: item.topBRowId, aRecord: { name: index === 1 ? "Target organization" : "Acme" }, evidence: [{ ...first.evidence[0]!, aValue: index === 1 ? "Target organization" : "Acme" }] })),
    decisions: [], conflicts: [], reviewQueue, reviewProgress: { total: reviewQueue.length, reviewed: 0, remaining: reviewQueue.length, deferred: 0 }, reviewUndo: null, onlyA: [], onlyB: [],
  };
}

describe("review model", () => {
  it("sorts ambiguity deterministically and filters collisions, alternatives, and safe search values", () => {
    const items = [queue(3), queue(1, { collision: true }), queue(2, { candidateCount: 2 })];
    const value = runView(items);
    expect(reviewItems(value, "unresolved", "ambiguity", "").map((item) => item.aRowId)).toEqual(["A1", "A2", "A3"]);
    expect(reviewItems(value, "collision", "source", "").map((item) => item.aRowId)).toEqual(["A1"]);
    expect(reviewItems(value, "multiple", "source", "").map((item) => item.aRowId)).toEqual(["A2"]);
    expect(reviewItems(value, "all", "source", "target").map((item) => item.aRowId)).toEqual(["A1"]);
  });

  it("expresses missing and conflict evidence with deterministic non-color labels", () => {
    expect(evidenceStateLabel(candidate("missing_left"), "name")).toBe("Missing A");
    expect(evidenceStateLabel(candidate("missing_right"), "name")).toBe("Missing B");
    expect(evidenceStateLabel(candidate("missing_both"), "name")).toBe("Missing both");
    expect(evidenceStateLabel(candidate("conflict"), "name")).toBe("Conflict");
  });
});
