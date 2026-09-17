import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CandidatePair, RunSummary } from "@samewise/contracts";
import { ReviewWorkspace } from "./ReviewWorkspace.js";

const evidence = { mappingId: "name", label: "Name", aColumn: "name", bColumn: "name", aValue: "Acme", bValue: "Acme Inc", normalizedA: "acme", normalizedB: "acme inc", fieldKind: "name" as const, featurePipelineVersion: "feature-pipeline-v0.1.0" as const, features: [{ name: "token_similarity", value: 0.9 }], outcome: "similar" as const, evidenceClass: "partial_agreement" as const, weight: 2, positiveContribution: 0.8, conflictContribution: 0, contribution: 0.8, explanationCode: "name_partial", explanation: "Names partially agree." };

function candidate(id: string, bRowId: string, rank: number, score: number): CandidatePair {
  return { candidateId: id, aRowId: "A1", bRowId, aRecord: { name: "Acme", status: "active" }, bRecord: { name: `${bRowId} Inc`, status: "inactive" }, rank, matchScore: score, runnerUpMargin: 0.05, band: "needs_review", collision: rank === 1, strongContradiction: false, blockingEvidence: [{ blockerId: "name", keyHash: "0123456789abcdef" }], positiveEvidence: 0.8, conflictEvidence: 0, totalWeight: 2, evidence: [evidence] };
}

const candidates = [candidate("c11", "B1", 1, 0.8), candidate("c12", "B2", 2, 0.75)];
const summaries = candidates.map((item) => ({ candidateId: item.candidateId, bRowId: item.bRowId, rank: item.rank, matchScore: item.matchScore, band: item.band, collision: item.collision, strongContradiction: false, strongestPositive: { mappingId: "name", label: "Name", evidenceClass: "partial_agreement" as const, contribution: 0.8 }, strongestContradiction: null, humanDecision: null }));

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return { contractVersion: "1.0.0", projectionVersion: "1.0.0", runId: "run-review", stage: "review", datasets: {}, mappings: [], mappingVersion: "confirmed-mappings-v1", semanticMappingProvenance: null, matcherVersion: "explainable-matcher-v0.2.0", matcherProvenance: { matcherVersion: "explainable-matcher-v0.2.0", candidateEngineVersion: "candidate-engine-v0.2.0", blockingNormalizationVersion: "blocking-normalization-v0.1.0", featurePipelineVersion: "feature-pipeline-v0.1.0", matcherConfigVersion: "matcher-config-v0.2.0", matcherConfig: {} }, summary: { matched: 0, needsReview: 1, onlyA: 0, onlyB: 2 }, survivorshipPolicy: null, trustedExportReadiness: { ready: false, unresolvedIdentityCount: 1, unresolvedConflictCount: 0, eligibleConfirmedCount: 0, onlyACount: 0, onlyBCount: 2, blockers: ["review"] }, reviewProgress: { total: 1, reviewed: 0, remaining: 1, deferred: 0 }, reviewUndo: null, conflictSummary: { total: 0, resolved: 0, unresolved: 0 }, ...overrides };
}

function reviewPage() {
  return { contractVersion: "1.0.0", runId: "run-review", items: [{ aRowId: "A1", topCandidateId: "c11", topBRowId: "B1", topMatchScore: 0.8, runnerUpMargin: 0.05, candidateCount: 2, strongestPositive: summaries[0]!.strongestPositive, strongestContradiction: null, collision: true, collisionARowIds: ["A2"], strongContradiction: false, state: "needs_review", deferred: false, humanDecision: null, matcherVersion: "explainable-matcher-v0.2.0", sourceOrder: 0, aIdentity: { name: "Acme" }, topBIdentity: { name: "B1 Inc" }, candidates: summaries }], page: { offset: 0, limit: 50, total: 1, returned: 1, nextOffset: null, previousOffset: null }, progress: { total: 1, reviewed: 0, remaining: 1, deferred: 0 }, filter: "unresolved", sort: "ambiguity", query: "" };
}

function detail(candidateId = "c11") {
  const selected = candidates.find((item) => item.candidateId === candidateId)!;
  return { contractVersion: "1.0.0", runId: "run-review", candidate: selected, alternatives: summaries, reviewState: "needs_review", deferred: false, collisionARowIds: candidateId === "c11" ? ["A2"] : [], effectiveCollisionARowIds: [], humanDecision: null, conflicts: [], matcherVersion: "explainable-matcher-v0.2.0", candidateEngineVersion: "candidate-engine-v0.2.0" };
}

function fetchSuccess() {
  return vi.fn((input: string | URL | Request) => Promise.resolve(new Response(JSON.stringify(String(input).includes("/review?") ? reviewPage() : detail(String(input).endsWith("c12") ? "c12" : "c11")), { status: 200, headers: { "Content-Type": "application/json" } })));
}

const noop = vi.fn(async () => run());

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("bounded review workspace", () => {
  it("loads a bounded queue and full evidence separately", async () => {
    const fetchMock = fetchSuccess();
    vi.stubGlobal("fetch", fetchMock);
    render(<ReviewWorkspace run={run()} busy={false} onDecision={noop} onDefer={noop} onUndo={noop} onGoResolution={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Are A1 and B1 the same entity?" })).toBeInTheDocument();
    expect(screen.getAllByText("Names partially agree.").length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/review?"))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/candidates/c11"))).toBe(true);
  });

  it("switches candidate rank without recording a decision", async () => {
    vi.stubGlobal("fetch", fetchSuccess());
    const onDecision = vi.fn(async () => run());
    render(<ReviewWorkspace run={run()} busy={false} onDecision={onDecision} onDefer={noop} onUndo={noop} onGoResolution={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Select candidate rank 2/ }));
    expect(await screen.findByRole("heading", { name: "Are A1 and B2 the same entity?" })).toBeInTheDocument();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("keeps SAME, DIFFERENT, defer, and undo keyboard actions wired", async () => {
    vi.stubGlobal("fetch", fetchSuccess());
    const onDecision = vi.fn(async () => run());
    const onDefer = vi.fn(async () => run());
    const onUndo = vi.fn(async () => run());
    const undoRun = run({ reviewUndo: { decisionId: "d1", candidateId: "c11", aRowId: "A1", bRowId: "B1", humanDecision: "different_entity", canUndo: true, blockedReason: null } });
    render(<ReviewWorkspace run={undoRun} busy={false} onDecision={onDecision} onDefer={onDefer} onUndo={onUndo} onGoResolution={vi.fn()} />);
    await screen.findByRole("heading", { name: "Are A1 and B1 the same entity?" });
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(onDecision).toHaveBeenCalledWith("c11", "same_entity"));
    fireEvent.keyDown(window, { key: "e" });
    await waitFor(() => expect(onDefer).toHaveBeenCalledWith("A1", true));
    fireEvent.keyDown(window, { key: "u" });
    await waitFor(() => expect(onUndo).toHaveBeenCalled());
  });

  it("shows evidence loading without stale evidence", async () => {
    let resolveDetail!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => String(input).includes("/review?")
      ? Promise.resolve(new Response(JSON.stringify(reviewPage()), { status: 200 }))
      : new Promise<Response>((resolve) => { resolveDetail = resolve; })));
    render(<ReviewWorkspace run={run()} initialCandidateId="c11" busy={false} onDecision={noop} onDefer={noop} onUndo={noop} onGoResolution={vi.fn()} />);
    expect(await screen.findByText("Loading candidate evidence…")).toBeInTheDocument();
    expect(screen.queryByText("Names partially agree.")).not.toBeInTheDocument();
    resolveDetail(new Response(JSON.stringify(detail()), { status: 200 }));
    expect((await screen.findAllByText("Names partially agree.")).length).toBeGreaterThan(0);
  });

  it("shows detail failure and retries on demand", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewPage()), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detail()), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ReviewWorkspace run={run()} busy={false} onDecision={noop} onDefer={noop} onUndo={noop} onGoResolution={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Candidate evidence unavailable" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Are A1 and B1 the same entity?" })).toBeInTheDocument();
  });
});
