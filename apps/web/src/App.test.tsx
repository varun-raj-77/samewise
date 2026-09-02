import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MappingSuggestionResponse, RunView, SemanticMappingProposal } from "@samewise/contracts";
import { App } from "./App.js";

const evidence = { mappingId: "name", label: "Organization name", aColumn: "name", bColumn: "organization", aValue: "Acme Corp", bValue: "Acme Corporation", normalizedA: "acme", normalizedB: "acme", fieldKind: "name" as const, featurePipelineVersion: "feature-pipeline-v0.1.0" as const, features: [{ name: "token_similarity", value: 1 }], outcome: "similar" as const, evidenceClass: "partial_agreement" as const, weight: 2, positiveContribution: 0.72, conflictContribution: 0, contribution: 0.72, explanationCode: "name_partial", explanation: "Organization name has partial normalized agreement." };
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
    mappingVersion: "confirmed-mappings-v1", semanticMappingProvenance: null,
    matcherVersion: "explainable-matcher-v0.2.0", summary: { matched: 2, needsReview: 1, onlyA: 3, onlyB: 4 },
    matcherProvenance: { matcherVersion: "explainable-matcher-v0.2.0", candidateEngineVersion: "candidate-engine-v0.2.0", blockingNormalizationVersion: "blocking-normalization-v0.1.0", featurePipelineVersion: "feature-pipeline-v0.1.0", matcherConfigVersion: "matcher-config-v0.2.0", matcherConfig: { frozen: true } },
    candidates: [{ candidateId: "candidate-1-1", aRowId: "A1", bRowId: "B1", aRecord: { name: "Acme Corp", status: "active" }, bRecord: { organization: "Acme Corporation", status: "inactive" }, rank: 1, matchScore: 0.72, runnerUpMargin: 0.2, band: "needs_review", collision: false, strongContradiction: false, blockingEvidence: [{ blockerId: "name_token_v1", keyHash: "0123456789abcdef" }], positiveEvidence: 0.72, conflictEvidence: 0, totalWeight: 2, evidence: [evidence] }],
    decisions: [], conflicts: [], survivorshipPolicy: null,
    trustedExportReadiness: { ready: false, unresolvedIdentityCount: 1, unresolvedConflictCount: 0, eligibleConfirmedCount: 0, onlyACount: 0, onlyBCount: 0, blockers: ["1 identity review item(s) remain unresolved."] },
    reviewQueue: [{ aRowId: "A1", candidateIds: ["candidate-1-1"], topCandidateId: "candidate-1-1", topBRowId: "B1", topMatchScore: 0.72, runnerUpMargin: 0.2, candidateCount: 1, strongestPositive: { mappingId: "name", label: "Organization name", evidenceClass: "partial_agreement", contribution: 0.72 }, strongestContradiction: null, collision: false, collisionARowIds: [], strongContradiction: false, state: "needs_review", deferred: false, humanDecision: null, matcherVersion: "explainable-matcher-v0.2.0", sourceOrder: 0 }],
    reviewProgress: { total: 1, reviewed: 0, remaining: 1, deferred: 0 }, reviewUndo: null,
    onlyA: [], onlyB: [], ...overrides,
  };
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
    fireEvent.click(screen.getByRole("button", { name: "Save confirmed mappings & run matcher" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add at least one identity-evidence mapping");
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

  it("shows real API-shaped result categories and inspectable evidence", () => {
    render(<App initialRun={runView()} initialScreen="results" />);
    expect(screen.getByText("Matched").parentElement).toHaveTextContent("2");
    expect(screen.getByText(/Only B means no identity link is established/)).toBeInTheDocument();
    expect(screen.getByText("Needs review").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Only A").parentElement).toHaveTextContent("3");
    expect(screen.getByText("Only B").parentElement).toHaveTextContent("4");
    fireEvent.click(screen.getByRole("button", { name: /A1.*B1/ }));
    expect(screen.getByRole("heading", { name: "Are A1 and B1 the same entity?" })).toBeInTheDocument();
    expect(screen.getByText("Selection alone never records a decision.")).toBeInTheDocument();
    expect(screen.getAllByText("0.720").length).toBeGreaterThan(0);
    expect(screen.getByText("Strong agreement")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Feature detail and matcher explanation"));
    expect(screen.getByText("token similarity")).toBeInTheDocument();
  });

  it("keeps SAME ENTITY separate from explicit field resolution", async () => {
    const conflictRun = runView({
      stage: "resolution",
      decisions: [{ decisionId: "d1", runId: "run-1", candidateId: "candidate-1-1", aRowId: "A1", bRowId: "B1", systemProposal: "needs_review", humanDecision: "same_entity", matcherVersion: "explainable-matcher-v0.2.0", evidenceShown: [evidence], decidedAt: "2026-08-30T12:00:00.000Z" }],
      conflicts: [{ conflictId: "c1", runId: "run-1", candidateId: "candidate-1-1", mappingId: "status", label: "Status", aColumn: "status", bColumn: "status", aValue: "active", bValue: "inactive", identityDecisionId: "d1", identitySource: "human", status: "unresolved", resolution: null, resolutionHistory: [] }],
      trustedExportReadiness: { ready: false, unresolvedIdentityCount: 0, unresolvedConflictCount: 1, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: ["1 comparison-field conflict(s) remain unresolved."] },
    });
    const resolvedRun = runView({ ...conflictRun, conflicts: [{ ...conflictRun.conflicts[0]!, status: "resolved", resolution: { resolutionId: "r1", strategy: "use_a", resolutionSource: "manual", chosenSource: "A", chosenValue: "active", keptValues: [], reasonCode: "use_a", reason: "A user explicitly selected Dataset A.", policyVersion: null, ruleId: null, inputSnapshot: { aValue: "active", bValue: "inactive", aTimestamp: null, bTimestamp: null }, resolvedAt: "2026-08-30T12:01:00.000Z" } }], trustedExportReadiness: { ready: true, unresolvedIdentityCount: 0, unresolvedConflictCount: 0, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: [] } });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(conflictRun), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(resolvedRun), { status: 200, headers: { "Content-Type": "application/json" } })));
    render(<App initialRun={runView()} initialScreen="results" />);
    fireEvent.click(screen.getByRole("button", { name: /A1.*B1/ }));
    fireEvent.click(screen.getByRole("button", { name: "Same entity" }));
    expect((await screen.findByText("1 field conflict")).parentElement).toHaveTextContent("Zero values were selected automatically.");
    fireEvent.click(screen.getByRole("button", { name: "Resolve values separately" }));
    expect(screen.getByRole("heading", { name: "Identity is settled. Values are not." })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use A" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Use A" }));
    await waitFor(() => expect(screen.getByText(/manual · use a/i)).toBeInTheDocument());
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
    expect(screen.getByText("Trusted output").parentElement).toHaveTextContent("Blocked");
    expect(screen.getByRole("button", { name: "Download reconciliation report" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Download trusted merged output" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("identity review item");
  });
});
