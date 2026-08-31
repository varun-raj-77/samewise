import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunView } from "@samewise/contracts";
import { App } from "./App.js";

const evidence = { mappingId: "name", label: "Organization name", aColumn: "name", bColumn: "organization", aValue: "Acme Corp", bValue: "Acme Corporation", normalizedA: "acme corp", normalizedB: "acme corporation", outcome: "similar" as const, contribution: 0.72, explanation: "Normalized text similarity is the displayed contribution." };
const mapping = { mappingId: "name", label: "Organization name", aColumn: "name", bColumn: "organization", role: "identity" as const, normalizer: "text" as const };
const comparison = { mappingId: "status", label: "Status", aColumn: "status", bColumn: "status", role: "comparison" as const, normalizer: "text" as const };

function profile(side: "A" | "B") {
  return { contractVersion: "1.0.0" as const, datasetId: `dataset-${side}`, side, originalFilename: `${side.toLowerCase()}.csv`, sha256: side === "A" ? "a".repeat(64) : "b".repeat(64), rowCount: 1, columns: [
    { name: side === "A" ? "name" : "organization", inferredType: "string" as const, nullCount: 0, nullRate: 0, distinctCount: 1, distinctRate: 1, samples: ["Acme"] },
    { name: "status", inferredType: "string" as const, nullCount: 0, nullRate: 0, distinctCount: 1, distinctRate: 1, samples: ["active"] },
  ] };
}

function runView(overrides: Partial<RunView> = {}): RunView {
  return {
    contractVersion: "1.0.0", runId: "run-1", stage: "results",
    datasets: { A: profile("A"), B: profile("B") }, mappings: [mapping, comparison],
    matcherVersion: "baseline-matcher-v0.1.0", summary: { matched: 2, needsReview: 1, onlyA: 3, onlyB: 4 },
    candidates: [{ candidateId: "candidate-1-1", aRowId: "A1", bRowId: "B1", aRecord: { name: "Acme Corp", status: "active" }, bRecord: { organization: "Acme Corporation", status: "inactive" }, rank: 1, baselineScore: 0.72, runnerUpMargin: 0.2, band: "needs_review", collision: false, evidence: [evidence] }],
    decisions: [], conflicts: [], onlyA: [], onlyB: [], ...overrides,
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("Samewise vertical slice", () => {
  it("validates that both CSV files are selected", () => {
    render(<App initialRun={runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, summary: null, candidates: [] })} initialScreen="upload" />);
    fireEvent.click(screen.getByRole("button", { name: "Upload & profile" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose one CSV file for Dataset A and one for Dataset B");
  });

  it("renders Python-shaped dataset profiles and limited samples", () => {
    render(<App initialRun={runView()} initialScreen="profile" />);
    expect(screen.getByRole("heading", { name: "Know what arrived." })).toBeInTheDocument();
    expect(screen.getByText("a.csv")).toBeInTheDocument();
    expect(screen.getAllByText("Acme")).toHaveLength(2);
    expect(screen.getAllByText(/1 rows · SHA-256/)).toHaveLength(2);
  });

  it("requires an identity mapping on the manual mapping screen", () => {
    render(<App initialRun={runView({ mappings: [] })} initialScreen="mapping" />);
    fireEvent.click(screen.getByRole("button", { name: "Save mappings & run baseline" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add at least one identity-evidence mapping");
  });

  it("shows real API-shaped result categories and inspectable evidence", () => {
    render(<App initialRun={runView()} initialScreen="results" />);
    expect(screen.getByText("Matched").parentElement).toHaveTextContent("2");
    expect(screen.getByText(/Only B means no identity link is established/)).toBeInTheDocument();
    expect(screen.getByText("Needs review").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Only A").parentElement).toHaveTextContent("3");
    expect(screen.getByText("Only B").parentElement).toHaveTextContent("4");
    fireEvent.click(screen.getByRole("button", { name: /A1.*B1/ }));
    expect(screen.getByRole("heading", { name: "Are these the same real-world entity?" })).toBeInTheDocument();
    expect(screen.getByText("This decision will not choose any conflicting field value.")).toBeInTheDocument();
    expect(screen.getAllByText("0.720")).toHaveLength(2);
  });

  it("keeps SAME ENTITY separate from explicit field resolution", async () => {
    const conflictRun = runView({
      stage: "resolution",
      decisions: [{ decisionId: "d1", runId: "run-1", candidateId: "candidate-1-1", aRowId: "A1", bRowId: "B1", systemProposal: "needs_review", humanDecision: "same_entity", matcherVersion: "baseline-matcher-v0.1.0", evidenceShown: [evidence], decidedAt: "2026-08-30T12:00:00.000Z" }],
      conflicts: [{ conflictId: "c1", runId: "run-1", candidateId: "candidate-1-1", mappingId: "status", label: "Status", aColumn: "status", bColumn: "status", aValue: "active", bValue: "inactive", resolution: null }],
    });
    const resolvedRun = runView({ ...conflictRun, conflicts: [{ ...conflictRun.conflicts[0]!, resolution: { resolutionId: "r1", chosenSource: "A", chosenValue: "active", action: "use_a", resolvedAt: "2026-08-30T12:01:00.000Z" } }] });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(conflictRun), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(resolvedRun), { status: 200, headers: { "Content-Type": "application/json" } })));
    render(<App initialRun={runView()} initialScreen="results" />);
    fireEvent.click(screen.getByRole("button", { name: /A1.*B1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Same entity" }));
    expect(await screen.findByRole("heading", { name: "Identity is settled. Values are not." })).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use A" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Use A" }));
    await waitFor(() => expect(screen.getByText("Resolved · use A")).toBeInTheDocument());
  });

  it("shows a safe API error state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The API is unavailable");
  });
});
