import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResultsPage, RunSummary } from "@samewise/contracts";
import { ResultsWorkspace } from "./ResultsWorkspace.js";

const run: RunSummary = {
  contractVersion: "1.0.0", projectionVersion: "1.0.0", runId: "run-1", stage: "results",
  datasets: {}, mappings: [], mappingVersion: "confirmed-mappings-v3", semanticMappingProvenance: null,
  matcherVersion: "explainable-matcher-v0.3.0", matcherProvenance: null,
  summary: { matched: 1, needsReview: 1, onlyA: 0, onlyB: 0 }, survivorshipPolicy: null,
  trustedExportReadiness: { ready: false, unresolvedIdentityCount: 1, unresolvedConflictCount: 0, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: ["Identity review remains."] },
  reviewProgress: { total: 1, reviewed: 0, remaining: 1, deferred: 0 }, reviewUndo: null,
  conflictSummary: { total: 0, resolved: 0, unresolved: 0 },
};

function page(offset: number, aRowId: string): ResultsPage {
  return {
    contractVersion: "1.0.0", runId: "run-1", ordering: "a_row_id_ascending",
    items: [{ aRowId, aIdentity: { name: `Entity ${aRowId}` }, status: "needs_review", topCandidate: { candidateId: `candidate-${aRowId}`, bRowId: `B${aRowId.slice(1)}`, rank: 1, matchScore: 0.6, band: "needs_review", collision: false, strongContradiction: false, strongestPositive: null, strongestContradiction: null, humanDecision: null }, topBIdentity: { organization: `Candidate ${aRowId}` }, alternativeCount: 0, collision: false, sourceOrder: offset }],
    page: { offset, limit: 50, total: 51, returned: 1, nextOffset: offset === 0 ? 50 : null, previousOffset: offset === 0 ? null : 0 },
  };
}

describe("bounded results workspace", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pages through bounded result projections", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => Promise.resolve(new Response(
      JSON.stringify(String(input).includes("offset=50") ? page(50, "A51") : page(0, "A1")),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )));
    vi.stubGlobal("fetch", fetchMock);
    render(<ResultsWorkspace run={run} onReview={vi.fn()} onResolution={vi.fn()} onOpenReview={vi.fn()} onExport={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /A1.*B1/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("button", { name: /A51.*B51/ })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("offset=50&limit=50"))).toBe(true);
  });

  it("hands unresolved identity work to Review using authoritative progress", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(page(0, "A1")), { status: 200, headers: { "Content-Type": "application/json" } })));
    const onOpenReview = vi.fn();
    render(<ResultsWorkspace run={{ ...run, reviewProgress: { total: 3, reviewed: 1, remaining: 1, deferred: 1 } }} onReview={vi.fn()} onResolution={vi.fn()} onOpenReview={onOpenReview} onExport={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "2 uncertain matches" })).toBeInTheDocument();
    expect(screen.getByText("Need your review").parentElement).toHaveTextContent("2");
    expect(screen.getByText("Matched automatically / confirmed").parentElement).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "Review 2 uncertain matches" }));
    expect(onOpenReview).toHaveBeenCalledOnce();
  });
});
