import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";

import type { CandidatePair, ReviewQueueItem, RunView } from "@samewise/contracts";
import { ReviewWorkspace } from "./ReviewWorkspace.js";

const evidence = { mappingId: "name", label: "Organization name", aColumn: "name", bColumn: "organization", aValue: "Acme Corp", bValue: "Acme Corporation", normalizedA: "acme corp", normalizedB: "acme corporation", fieldKind: "name" as const, featurePipelineVersion: "feature-pipeline-v0.1.0" as const, features: [{ name: "token_similarity", value: 0.91 }], outcome: "similar" as const, evidenceClass: "partial_agreement" as const, weight: 2, positiveContribution: 0.72, conflictContribution: 0, contribution: 0.72, explanationCode: "name_partial", explanation: "Organization name has partial normalized agreement." };

function candidate(candidateId: string, aRowId: string, bRowId: string, rank: number, overrides: Partial<CandidatePair> = {}): CandidatePair {
  return {
    candidateId, aRowId, bRowId,
    aRecord: { id: aRowId, name: `${aRowId} Acme`, status: "active" },
    bRecord: { id: bRowId, organization: `${bRowId} Acme Co`, status: "inactive" },
    rank, matchScore: 0.72 - (rank - 1) * 0.08, runnerUpMargin: 0.02,
    band: "needs_review", collision: false, strongContradiction: false,
    blockingEvidence: [{ blockerId: "name_token_v1", keyHash: "0123456789abcdef" }],
    positiveEvidence: 0.72, conflictEvidence: 0, totalWeight: 2, evidence: [{ ...evidence, aValue: `${aRowId} Acme`, bValue: `${bRowId} Acme Co` }],
    ...overrides,
  };
}

function queueItem(aRowId: string, candidates: CandidatePair[], overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  const top = candidates[0]!;
  return {
    aRowId, candidateIds: candidates.map((item) => item.candidateId), topCandidateId: top.candidateId,
    topBRowId: top.bRowId, topMatchScore: top.matchScore, runnerUpMargin: top.runnerUpMargin,
    candidateCount: candidates.length, strongestPositive: { mappingId: "name", label: "Organization name", evidenceClass: "partial_agreement", contribution: 0.72 },
    strongestContradiction: null, collision: false, collisionARowIds: [], strongContradiction: false,
    state: "needs_review", deferred: false, humanDecision: null,
    matcherVersion: "explainable-matcher-v0.2.0", sourceOrder: Number(aRowId.replace(/\D/g, "")) - 1,
    ...overrides,
  };
}

function run(candidates: CandidatePair[], reviewQueue: ReviewQueueItem[], overrides: Partial<RunView> = {}): RunView {
  const reviewed = reviewQueue.filter((item) => item.state.startsWith("reviewed")).length;
  const remaining = reviewQueue.filter((item) => item.state === "needs_review").length;
  const deferred = reviewQueue.filter((item) => item.state === "deferred").length;
  return {
    contractVersion: "1.0.0", runId: "run-review", stage: "review", datasets: {},
    mappings: [], mappingVersion: "confirmed-mappings-v1", semanticMappingProvenance: null,
    matcherVersion: "explainable-matcher-v0.2.0",
    matcherProvenance: { matcherVersion: "explainable-matcher-v0.2.0", candidateEngineVersion: "candidate-engine-v0.2.0", blockingNormalizationVersion: "blocking-normalization-v0.1.0", featurePipelineVersion: "feature-pipeline-v0.1.0", matcherConfigVersion: "matcher-config-v0.2.0", matcherConfig: { frozen: true } },
    summary: { matched: reviewed, needsReview: remaining + deferred, onlyA: 0, onlyB: candidates.length },
    candidates, decisions: [], conflicts: [], survivorshipPolicy: null,
    trustedExportReadiness: { ready: false, unresolvedIdentityCount: remaining + deferred, unresolvedConflictCount: 0, eligibleConfirmedCount: reviewed, onlyACount: 0, onlyBCount: 0, blockers: ["Identity review remains."] }, reviewQueue,
    reviewProgress: { total: reviewQueue.length, reviewed, remaining, deferred }, reviewUndo: null,
    onlyA: [], onlyB: [], ...overrides,
  };
}

function renderWorkspace(value: RunView, callbacks: Partial<ComponentProps<typeof ReviewWorkspace>> = {}) {
  const defaults = {
    run: value, busy: false,
    onDecision: vi.fn(async () => value),
    onDefer: vi.fn(async () => value),
    onUndo: vi.fn(async () => value),
    onGoResolution: vi.fn(),
  };
  const props: ComponentProps<typeof ReviewWorkspace> = { ...defaults, ...callbacks, run: value };
  function Harness() {
    const [current, setCurrent] = useState(value);
    return <ReviewWorkspace
      {...props}
      run={current}
      onDecision={async (...arguments_) => { const next = await props.onDecision(...arguments_); if (next) setCurrent(next); return next; }}
      onDefer={async (...arguments_) => { const next = await props.onDefer(...arguments_); if (next) setCurrent(next); return next; }}
      onUndo={async () => { const next = await props.onUndo(); if (next) setCurrent(next); return next; }}
    />;
  }
  render(<Harness />);
  return props;
}

describe("SW-007 review workspace", () => {
  it("switches alternate candidates semantically without recording a decision", () => {
    const options = [candidate("c11", "A1", "B1", 1), candidate("c12", "A1", "B2", 2)];
    const value = run(options, [queueItem("A1", options)]);
    const props = renderWorkspace(value);
    const alternate = screen.getByRole("button", { name: /candidate rank 2, B2/ });
    expect(alternate).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(alternate);
    expect(screen.getByRole("heading", { name: "Are A1 and B2 the same entity?" })).toHaveFocus();
    expect(alternate).toHaveAttribute("aria-pressed", "true");
    expect(props.onDecision).not.toHaveBeenCalled();
  });

  it("reopens a completed SAME item on its human-confirmed candidate and conflicts", () => {
    const options = [candidate("c11", "A1", "B1", 1), candidate("c12", "A1", "B2", 2)];
    const active = candidate("c21", "A2", "B3", 1);
    const decidedAt = "2026-09-01T12:00:00.000Z";
    const decision = { decisionId: "d1", runId: "run-review", candidateId: "c11", aRowId: "A1", bRowId: "B1", systemProposal: "needs_review" as const, humanDecision: "same_entity" as const, matcherVersion: "explainable-matcher-v0.2.0" as const, candidateEngineVersion: "candidate-engine-v0.2.0" as const, matchScore: 0.72, evidenceShown: options[0]!.evidence, decidedAt };
    const value = run([...options, active], [
      queueItem("A1", options, { state: "reviewed_same", humanDecision: { candidateId: "c11", bRowId: "B1", humanDecision: "same_entity", decidedAt } }),
      queueItem("A2", [active]),
    ], {
      decisions: [decision],
      conflicts: [{ conflictId: "conflict-c11-status", runId: "run-review", candidateId: "c11", mappingId: "status", label: "Status", aColumn: "status", bColumn: "status", aValue: "active", bValue: "inactive", identityDecisionId: decision.decisionId, identitySource: "human", status: "unresolved", resolution: null, resolutionHistory: [] }],
      reviewProgress: { total: 2, reviewed: 1, remaining: 1, deferred: 0 },
    });
    renderWorkspace(value);
    fireEvent.change(screen.getByLabelText("Filter review queue"), { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: /A1, candidate B1/ }));
    expect(screen.getByRole("heading", { name: "Are A1 and B1 the same entity?" })).toHaveFocus();
    expect(screen.getByRole("button", { name: /candidate rank 1, B1/ })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".post-identity-conflicts")).toHaveTextContent("1 field conflict created after SAME");
  });

  it("records SAME with S, announces success, auto-advances, and focuses the next case", async () => {
    const first = candidate("c11", "A1", "B1", 1);
    const second = candidate("c21", "A2", "B3", 1);
    const initial = run([first, second], [queueItem("A1", [first]), queueItem("A2", [second])]);
    const decision = { decisionId: "d1", runId: initial.runId, candidateId: "c11", aRowId: "A1", bRowId: "B1", systemProposal: "needs_review" as const, humanDecision: "same_entity" as const, matcherVersion: "explainable-matcher-v0.2.0" as const, candidateEngineVersion: "candidate-engine-v0.2.0" as const, matchScore: 0.72, evidenceShown: first.evidence, decidedAt: "2026-09-01T12:00:00.000Z" };
    const updated = run([first, second], [
      queueItem("A1", [first], { state: "reviewed_same", humanDecision: { candidateId: "c11", bRowId: "B1", humanDecision: "same_entity", decidedAt: decision.decidedAt } }),
      queueItem("A2", [second]),
    ], { decisions: [decision], reviewProgress: { total: 2, reviewed: 1, remaining: 1, deferred: 0 } });
    const onDecision = vi.fn(async () => updated);
    renderWorkspace(initial, { onDecision });
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(onDecision).toHaveBeenCalledWith("c11", "same_entity"));
    expect(await screen.findByText(/Same entity recorded for A1 and B1/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Are A2 and B3 the same entity?" })).toHaveFocus());
  });

  it("records DIFFERENT with D and advances to the next undecided alternative", async () => {
    const options = [candidate("c11", "A1", "B1", 1), candidate("c12", "A1", "B2", 2)];
    const initial = run(options, [queueItem("A1", options)]);
    const decision = { decisionId: "d1", runId: initial.runId, candidateId: "c11", aRowId: "A1", bRowId: "B1", systemProposal: "needs_review" as const, humanDecision: "different_entity" as const, matcherVersion: "explainable-matcher-v0.2.0" as const, candidateEngineVersion: "candidate-engine-v0.2.0" as const, matchScore: 0.72, evidenceShown: options[0]!.evidence, decidedAt: "2026-09-01T12:00:00.000Z" };
    const updated = run(options, [queueItem("A1", options, { humanDecision: { candidateId: "c11", bRowId: "B1", humanDecision: "different_entity", decidedAt: decision.decidedAt } })], { decisions: [decision] });
    const onDecision = vi.fn(async () => updated);
    renderWorkspace(initial, { onDecision });
    fireEvent.keyDown(window, { key: "d" });
    await waitFor(() => expect(onDecision).toHaveBeenCalledWith("c11", "different_entity"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Are A1 and B2 the same entity?" })).toHaveFocus());
    expect(screen.getByText(/Different entity recorded for A1 and B1/)).toBeInTheDocument();
  });

  it("supports candidate rank, queue navigation, defer, and undo shortcuts without firing while typing", async () => {
    const a1 = [candidate("c11", "A1", "B1", 1), candidate("c12", "A1", "B2", 2)];
    const a2 = [candidate("c21", "A2", "B3", 1)];
    const initial = run([...a1, ...a2], [queueItem("A1", a1), queueItem("A2", a2)]);
    const deferred = run([...a1, ...a2], [queueItem("A1", a1, { state: "deferred", deferred: true }), queueItem("A2", a2)], { reviewProgress: { total: 2, reviewed: 0, remaining: 1, deferred: 1 } });
    const onDefer = vi.fn(async () => deferred);
    const onDecision = vi.fn(async () => initial);
    renderWorkspace(initial, { onDefer, onDecision });
    fireEvent.keyDown(window, { key: "2" });
    expect(screen.getByRole("heading", { name: "Are A1 and B2 the same entity?" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "j" });
    expect(screen.getByRole("heading", { name: "Are A2 and B3 the same entity?" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k" });
    expect(screen.getByRole("heading", { name: "Are A1 and B1 the same entity?" })).toBeInTheDocument();
    const search = screen.getByRole("searchbox", { name: "Search review queue" });
    search.focus();
    fireEvent.keyDown(search, { key: "s" });
    expect(onDecision).not.toHaveBeenCalled();
    search.blur();
    fireEvent.keyDown(window, { key: "e" });
    await waitFor(() => expect(onDefer).toHaveBeenCalledWith("A1", true));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Are A2 and B3 the same entity?" })).toHaveFocus());
  });

  it("undoes with U and returns focus to the restored case", async () => {
    const first = candidate("c11", "A1", "B1", 1);
    const reviewed = queueItem("A1", [first], { state: "reviewed_different", humanDecision: { candidateId: "c11", bRowId: "B1", humanDecision: "different_entity", decidedAt: "2026-09-01T12:00:00.000Z" } });
    const initial = run([first], [reviewed], { reviewProgress: { total: 1, reviewed: 1, remaining: 0, deferred: 0 }, reviewUndo: { decisionId: "d1", candidateId: "c11", aRowId: "A1", bRowId: "B1", humanDecision: "different_entity", canUndo: true, blockedReason: null } });
    const restored = run([first], [queueItem("A1", [first])]);
    const onUndo = vi.fn(async () => restored);
    renderWorkspace(initial, { onUndo });
    fireEvent.keyDown(window, { key: "u" });
    await waitFor(() => expect(onUndo).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Review decision for A1 and B1 was undone/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Are A1 and B1 the same entity?" })).toHaveFocus());
  });

  it("shows non-color collision context and keeps actions as accessible buttons", () => {
    const first = candidate("c11", "A1", "B1", 1, { collision: true });
    const competing = candidate("c21", "A2", "B1", 1, { collision: true });
    const value = run([first, competing], [queueItem("A1", [first], { collision: true, collisionARowIds: ["A2"] }), queueItem("A2", [competing], { collision: true, collisionARowIds: ["A1"] })]);
    renderWorkspace(value);
    expect(screen.getByLabelText("Candidate collision warning")).toHaveTextContent("B1 is also a candidate for A2");
    expect(screen.getByLabelText("Candidate collision warning")).toHaveTextContent("does not enforce global one-to-one identity");
    expect(screen.getByRole("button", { name: /Same entity/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Different entity/ })).toBeEnabled();
    expect(screen.getAllByText("needs review").length).toBeGreaterThan(0);
  });
});
