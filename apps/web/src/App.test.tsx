import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MappingSuggestionResponse, RunSummary, SemanticMappingProposal } from "@samewise/contracts";
import { App } from "./App.js";

const evidence = { mappingId: "name", label: "Organization name", aColumn: "name", bColumn: "organization", aValue: "Acme Corp", bValue: "Acme Corporation", normalizedA: "acme", normalizedB: "acme", fieldKind: "name" as const, featurePipelineVersion: "feature-pipeline-v0.1.0" as const, features: [{ name: "token_similarity", value: 1 }], outcome: "similar" as const, evidenceClass: "partial_agreement" as const, weight: 2, positiveContribution: 0.72, conflictContribution: 0, contribution: 0.72, explanationCode: "name_partial", explanation: "Organization name has partial normalized agreement." };
const candidate = { candidateId: "candidate-1-1", aRowId: "A1", bRowId: "B1", aRecord: { name: "Acme Corp", status: "active" }, bRecord: { organization: "Acme Corporation", status: "inactive" }, rank: 1, matchScore: 0.72, runnerUpMargin: 0.2, band: "needs_review" as const, collision: false, strongContradiction: false, blockingEvidence: [{ blockerId: "name_token_v1", keyHash: "0123456789abcdef" }], positiveEvidence: 0.72, conflictEvidence: 0, totalWeight: 2, evidence: [evidence] };
const candidateSummary = { candidateId: candidate.candidateId, bRowId: candidate.bRowId, rank: 1, matchScore: 0.72, band: "needs_review" as const, collision: false, strongContradiction: false, strongestPositive: { mappingId: "name", label: "Organization name", evidenceClass: "partial_agreement" as const, contribution: 0.72 }, strongestContradiction: null, humanDecision: null };
const mapping = { mappingId: "name", label: "Organization name", aColumn: "name", bColumn: "organization", role: "identity" as const, normalizer: "text" as const };
const comparison = { mappingId: "status", label: "Status", aColumn: "status", bColumn: "status", role: "comparison" as const, normalizer: "text" as const };

function profile(side: "A" | "B") {
  return { contractVersion: "1.0.0" as const, datasetId: `dataset-${side}`, side, originalFilename: `${side.toLowerCase()}.csv`, sha256: side === "A" ? "a".repeat(64) : "b".repeat(64), rowCount: 1, columns: [
    { name: side === "A" ? "name" : "organization", inferredType: "string" as const, nullCount: 0, nullRate: 0, distinctCount: 1, distinctRate: 1, samples: ["Acme"] },
    { name: "status", inferredType: "string" as const, nullCount: 0, nullRate: 0, distinctCount: 1, distinctRate: 1, samples: ["active"] },
  ] };
}

function runView(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    contractVersion: "1.0.0", projectionVersion: "1.0.0", runId: "run-1", stage: "results",
    datasets: { A: profile("A"), B: profile("B") }, mappings: [mapping, comparison],
    mappingVersion: "confirmed-mappings-v1", semanticMappingProvenance: null,
    matcherVersion: "explainable-matcher-v0.2.0", summary: { matched: 2, needsReview: 1, onlyA: 3, onlyB: 4 },
    matcherProvenance: { matcherVersion: "explainable-matcher-v0.2.0", candidateEngineVersion: "candidate-engine-v0.3.0", blockingNormalizationVersion: "blocking-normalization-v0.1.0", featurePipelineVersion: "feature-pipeline-v0.1.0", matcherConfigVersion: "matcher-config-v0.2.0", matcherConfig: { frozen: true } },
    survivorshipPolicy: null,
    trustedExportReadiness: { ready: false, unresolvedIdentityCount: 1, unresolvedConflictCount: 0, eligibleConfirmedCount: 0, onlyACount: 0, onlyBCount: 0, blockers: ["1 identity review item(s) remain unresolved."] },
    reviewProgress: { total: 1, reviewed: 0, remaining: 1, deferred: 0 }, reviewUndo: null,
    conflictSummary: { total: 0, resolved: 0, unresolved: 0 }, ...overrides,
  };
}

function resultsPage() {
  return { contractVersion: "1.0.0", runId: "run-1", items: [{ aRowId: "A1", aIdentity: { name: "Acme Corp" }, status: "needs_review", topCandidate: candidateSummary, topBIdentity: { organization: "Acme Corporation" }, alternativeCount: 0, collision: false, sourceOrder: 0 }], page: { offset: 0, limit: 50, total: 1, returned: 1, nextOffset: null, previousOffset: null }, ordering: "a_row_id_ascending" };
}

function reviewPage() {
  return { contractVersion: "1.0.0", runId: "run-1", items: [{ aRowId: "A1", topCandidateId: candidate.candidateId, topBRowId: "B1", topMatchScore: 0.72, runnerUpMargin: 0.2, candidateCount: 1, strongestPositive: candidateSummary.strongestPositive, strongestContradiction: null, collision: false, collisionARowIds: [], strongContradiction: false, state: "needs_review", deferred: false, humanDecision: null, matcherVersion: "explainable-matcher-v0.2.0", sourceOrder: 0, aIdentity: { name: "Acme Corp" }, topBIdentity: { organization: "Acme Corporation" }, candidates: [candidateSummary] }], page: { offset: 0, limit: 50, total: 1, returned: 1, nextOffset: null, previousOffset: null }, progress: { total: 1, reviewed: 0, remaining: 1, deferred: 0 }, filter: "unresolved", sort: "ambiguity", query: "" };
}

function candidateDetail() {
  return { contractVersion: "1.0.0", runId: "run-1", candidate, alternatives: [candidateSummary], reviewState: "needs_review", deferred: false, collisionARowIds: [], effectiveCollisionARowIds: [], humanDecision: null, conflicts: [], matcherVersion: "explainable-matcher-v0.2.0", candidateEngineVersion: "candidate-engine-v0.3.0" };
}

function proposal(overrides: Partial<SemanticMappingProposal["suggestions"][number]> = {}): SemanticMappingProposal {
  return {
    contractVersion: "1.0.0", proposalId: "proposal-1", runId: "run-1",
    provenance: { provider: "openai", model: "test-model", promptVersion: "semantic-mapping-prompt-v1", schemaVersion: "1.0.0", requestVersion: "metadata-first-v1", responseId: "response-1" },
    suggestions: [{ suggestionId: "suggestion-1", leftColumn: "name", rightColumn: "organization", relation: "equivalent", role: "identity", confidence: 0.94, reason: "Both columns appear to contain organization names.", normalizationHints: ["casefold"], status: "pending", finalMapping: null, ...overrides }],
    unmappedLeft: ["status"], unmappedRight: ["status"], createdAt: "2026-08-31T12:00:00.000Z",
  };
}

function suggestionResponse(value = proposal(), confirmedMappings: MappingSuggestionResponse["confirmedMappings"] = []): MappingSuggestionResponse {
  return { contractVersion: "1.0.0", proposal: value, confirmedMappings };
}

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("Samewise vertical slice", () => {
  it("navigates between reconciliation and the dedicated Matcher evaluation product", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<App initialRun={runView()} initialScreen="results" />);
    fireEvent.click(screen.getByRole("button", { name: "Matcher evaluation" }));
    expect(screen.getByRole("button", { name: "Matcher evaluation" })).toHaveAttribute("aria-current", "page");
    expect(document.querySelector(".workspace.evaluation-layout")).toBeInTheDocument();
    expect(await screen.findByText("offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reconciliation" }));
    expect(screen.getByRole("heading", { name: "Evidence first, uncertainty visible." })).toBeInTheDocument();
  });

  it("validates that both CSV files are selected", () => {
    render(<App initialRun={runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, summary: null })} initialScreen="upload" />);
    fireEvent.click(screen.getByRole("button", { name: "Upload & profile" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose one CSV file for Dataset A and one for Dataset B");
  });

  it("offers New reconciliation from an active run without changing the current run", () => {
    render(<App initialRun={runView()} initialScreen="export" />);
    fireEvent.click(screen.getByRole("button", { name: "New reconciliation" }));
    expect(screen.getByRole("dialog", { name: "Start a new reconciliation?" })).toHaveTextContent("Your current run will remain unchanged.");
    expect(screen.getByText("run-1")).toBeInTheDocument();
  });

  it("cancels the New reconciliation confirmation", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={runView()} initialScreen="export" />);
    fireEvent.click(screen.getByRole("button", { name: "New reconciliation" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("run-1")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirms New reconciliation, creates a fresh run, and routes to Upload", async () => {
    const fresh = runView({ runId: "run-2", stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null, trustedExportReadiness: { ready: false, unresolvedIdentityCount: 0, unresolvedConflictCount: 0, eligibleConfirmedCount: 0, onlyACount: 0, onlyBCount: 0, blockers: ["The matcher has not completed."] }, reviewProgress: { total: 0, reviewed: 0, remaining: 0, deferred: 0 } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fresh), { status: 201, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={runView()} initialScreen="export" />);
    fireEvent.click(screen.getByRole("button", { name: "New reconciliation" }));
    fireEvent.click(screen.getByRole("button", { name: "Start new reconciliation" }));
    expect(await screen.findByRole("heading", { name: "Upload datasets" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/runs", { method: "POST" });
    await waitFor(() => expect(window.location.search).not.toContain("run-1"));
  });

  it("removes Dataset A before upload", () => {
    render(<App initialRun={runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null })} initialScreen="upload" />);
    const input = screen.getByLabelText("Dataset A CSV");
    fireEvent.change(input, { target: { files: [new File(["id\n1"], "first-a.csv", { type: "text/csv" })] } });
    expect(screen.getByText("first-a.csv")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Dataset A CSV" }));
    expect(screen.queryByText("first-a.csv")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Dataset A CSV" })).not.toBeInTheDocument();
  });

  it("replaces Dataset B before upload", () => {
    render(<App initialRun={runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null })} initialScreen="upload" />);
    const input = screen.getByLabelText("Dataset B CSV");
    fireEvent.change(input, { target: { files: [new File(["id\n1"], "old-b.csv", { type: "text/csv" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Replace Dataset B CSV" }));
    fireEvent.change(input, { target: { files: [new File(["id\n2"], "new-b.csv", { type: "text/csv" })] } });
    expect(screen.queryByText("old-b.csv")).not.toBeInTheDocument();
    expect(screen.getByText("new-b.csv")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Save confirmed mappings & run matcher" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add at least one identity-evidence mapping");
  });

  it("explains pending suggestions and the two mapping roles", () => {
    render(<App initialRun={runView()} initialScreen="mapping" />);
    expect(screen.getByText("Pending suggestions are not used.")).toBeInTheDocument();
    expect(screen.getByText(/Rejected and pending suggestions do not affect matching or field resolution/)).toBeInTheDocument();
    expect(screen.getByText("Used to determine whether records represent the same entity.")).toBeInTheDocument();
    expect(screen.getByText(/Compared only after identity is confirmed/)).toBeInTheDocument();
  });

  it("shows AI suggestion loading, evidence, advisory confidence, and no auto-confirmation", async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    render(<App initialRun={runView({ mappings: [] })} initialScreen="mapping" />);
    fireEvent.click(screen.getByRole("button", { name: "Request AI suggestions" }));
    expect(screen.getByText("Loading AI suggestions…")).toBeInTheDocument();
    resolveFetch(new Response(JSON.stringify(suggestionResponse()), { status: 201, headers: { "Content-Type": "application/json" } }));
    expect(await screen.findByText("Both columns appear to contain organization names.")).toBeInTheDocument();
    expect(screen.getByText("Model confidence · 94% (advisory)")).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Organization name")).not.toBeInTheDocument();
  });

  it("accepts a suggestion only after a user action and renders the confirmed mapping", async () => {
    const acceptedMapping = { ...mapping, mappingId: "mapping-suggestion-1", label: "name" };
    const acceptedProposal = proposal({ status: "accepted", finalMapping: acceptedMapping });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(suggestionResponse()), { status: 201, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(suggestionResponse(acceptedProposal, [acceptedMapping])), { status: 200, headers: { "Content-Type": "application/json" } })));
    render(<App initialRun={runView({ mappings: [] })} initialScreen="mapping" />);
    fireEvent.click(screen.getByRole("button", { name: "Request AI suggestions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(await screen.findByText("accepted")).toBeInTheDocument();
    expect(screen.getByLabelText("Mapping label")).toHaveValue("name");
  });

  it("rejects a suggestion without adding a mapping", async () => {
    const rejectedProposal = proposal({ status: "rejected" });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(suggestionResponse()), { status: 201, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(suggestionResponse(rejectedProposal)), { status: 200, headers: { "Content-Type": "application/json" } })));
    render(<App initialRun={runView({ mappings: [] })} initialScreen="mapping" />);
    fireEvent.click(screen.getByRole("button", { name: "Request AI suggestions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(await screen.findByText("rejected")).toBeInTheDocument();
    expect(screen.getByText("Add mappings the assistant missed, change any confirmed role, or continue entirely without AI.")).toBeInTheDocument();
  });

  it("remaps to another B column and role while showing the original proposed pair", async () => {
    const editedMapping = { mappingId: "edited", label: "name", aColumn: "name", bColumn: "status", role: "comparison" as const, normalizer: "text" as const };
    const editedProposal = proposal({ status: "edited", finalMapping: editedMapping });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(suggestionResponse()), { status: 201, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(suggestionResponse(editedProposal, [editedMapping])), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={runView({ mappings: [] })} initialScreen="mapping" />);
    fireEvent.click(screen.getByRole("button", { name: "Request AI suggestions" }));
    fireEvent.change(await screen.findByLabelText("Remap name Dataset B column"), { target: { value: "status" } });
    fireEvent.change(screen.getByLabelText("Confirmed role for name"), { target: { value: "comparison" } });
    fireEvent.click(screen.getByRole("button", { name: "Remap" }));
    expect(await screen.findByText("Confirmed: name ↔ status · comparison")).toBeInTheDocument();
    expect(screen.getByText("equivalent").closest("article")).toHaveTextContent("name↔organization");
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({ decision: "remap", finalMapping: { aColumn: "name", bColumn: "status", role: "comparison" } });
  });

  it("keeps manual mapping available when AI is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "ai_missing_key", message: "AI suggestions unavailable. You can continue mapping columns manually." } }), { status: 503, headers: { "Content-Type": "application/json" } })));
    render(<App initialRun={runView({ mappings: [] })} initialScreen="mapping" />);
    fireEvent.click(screen.getByRole("button", { name: "Request AI suggestions" }));
    expect(await screen.findByRole("status")).toHaveTextContent("continue mapping columns manually");
    expect(screen.getByRole("button", { name: "+ Add manual mapping" })).toBeEnabled();
  });

  it("loads bounded results and fetches inspectable evidence on demand", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      const value = url.includes("/results") ? resultsPage() : url.includes("/review?") ? reviewPage() : candidateDetail();
      return Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={runView()} initialScreen="results" />);
    expect(screen.getByText("Matched").parentElement).toHaveTextContent("2");
    expect(screen.getByText(/Only B means no identity link is established/)).toBeInTheDocument();
    expect(screen.getByText("Needs review").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Only A").parentElement).toHaveTextContent("3");
    expect(screen.getByText("Only B").parentElement).toHaveTextContent("4");
    fireEvent.click(await screen.findByRole("button", { name: /A1.*B1/ }));
    expect(await screen.findByRole("heading", { name: "Are A1 and B1 the same entity?" })).toBeInTheDocument();
    expect(screen.getByText("Selection alone never records a decision.")).toBeInTheDocument();
    expect(screen.getAllByText("0.720").length).toBeGreaterThan(0);
    expect(screen.getByText("Strong agreement")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Feature detail and matcher explanation"));
    expect(screen.getByText("token similarity")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/results?"))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/candidates/candidate-1-1"))).toBe(true);
  });

  it("shows a safe API error state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The API is unavailable");
  });

  it("recovers a live process-local run and review route after refresh", async () => {
    window.history.replaceState(null, "", "/?run=run-1&screen=review");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(runView({ stage: "review" })), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Resolve identity uncertainty." })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1");
    expect(window.location.search).toContain("run=run-1");
    expect(window.location.search).toContain("screen=review");
  });

  it("keeps the reconciliation report available while trusted merged output is blocked", () => {
    render(<App initialRun={runView()} initialScreen="export" />);
    expect(screen.getByRole("heading", { name: "Identity review isn't finished" })).toBeInTheDocument();
    expect(screen.getByText("Trusted merged output").parentElement).toHaveTextContent("Blocked");
    expect(screen.getByRole("button", { name: "Download reconciliation report" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Download trusted merged output" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download provenance manifest" })).toBeEnabled();
    expect(screen.getByText("reconciliation-export-v3.0.0")).toBeInTheDocument();
    expect(screen.getByText("trusted-merged-export-v2.0.0")).toBeInTheDocument();
    expect(screen.getByText("run-manifest-v1.0.0")).toBeInTheDocument();
    expect(screen.getByText("run-1")).toBeInTheDocument();
    expect(screen.getByText(`${"a".repeat(12)}…`)).toBeInTheDocument();
    expect(screen.getByText(`${"b".repeat(12)}…`)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("identity review item");
  });

  it("enables trusted output only after the server readiness gate passes", () => {
    render(<App initialRun={runView({ reviewProgress: { total: 1, reviewed: 1, remaining: 0, deferred: 0 }, trustedExportReadiness: { ready: true, unresolvedIdentityCount: 0, unresolvedConflictCount: 0, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: [] } })} initialScreen="export" />);
    expect(screen.getByRole("heading", { name: "Trusted-ready" })).toBeInTheDocument();
    expect(screen.getByText("Trusted merged output").parentElement).toHaveTextContent("Ready");
    expect(screen.getByRole("button", { name: "Download trusted merged output" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps trusted output blocked with an exact unresolved field-conflict reason", () => {
    render(<App initialRun={runView({ reviewProgress: { total: 1, reviewed: 1, remaining: 0, deferred: 0 }, trustedExportReadiness: { ready: false, unresolvedIdentityCount: 0, unresolvedConflictCount: 3, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: ["3 comparison-field conflict(s) remain unresolved."] } })} initialScreen="export" />);
    expect(screen.getByRole("heading", { name: "Field conflicts still need resolution" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("3 comparison-field conflict(s) remain unresolved.");
    expect(screen.getByRole("button", { name: "Download reconciliation report" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Download trusted merged output" })).toBeDisabled();
  });

  it("marks trusted output as identity-only when no comparison mappings were configured", () => {
    render(<App initialRun={runView({ mappings: [mapping], reviewProgress: { total: 0, reviewed: 0, remaining: 0, deferred: 0 }, trustedExportReadiness: { ready: true, unresolvedIdentityCount: 0, unresolvedConflictCount: 0, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: [] } })} initialScreen="export" />);
    expect(screen.getByRole("heading", { name: "Identity resolved · no comparison fields configured" })).toBeInTheDocument();
    expect(screen.getByText("Trusted merged output").parentElement).toHaveTextContent("Ready · identity only");
    expect(screen.getByText(/contains no reconciled comparison fields/)).toBeInTheDocument();
  });
});
