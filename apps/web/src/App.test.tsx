import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MappingSuggestionResponse, RunSummary, SemanticMappingProposal } from "@samewise/contracts";
import { App } from "./App.js";

const evidence = { mappingId: "name", label: "Organization name", aColumn: "name", bColumn: "organization", aValue: "Acme Corp", bValue: "Acme Corporation", normalizedA: "acme", normalizedB: "acme", fieldKind: "name_or_title" as const, featurePipelineVersion: "feature-pipeline-v0.2.0" as const, features: [{ name: "token_similarity", value: 1 }], outcome: "similar" as const, evidenceClass: "partial_agreement" as const, weight: 2, positiveContribution: 0.72, conflictContribution: 0, contribution: 0.72, explanationCode: "name_partial", explanation: "Organization name has partial normalized agreement." };
const candidate = { candidateId: "candidate-1-1", aRowId: "A1", bRowId: "B1", aRecord: { name: "Acme Corp", status: "active" }, bRecord: { organization: "Acme Corporation", status: "inactive" }, rank: 1, matchScore: 0.72, runnerUpMargin: 0.2, band: "needs_review" as const, collision: false, strongContradiction: false, blockingEvidence: [{ blockerId: "name_token_v1", keyHash: "0123456789abcdef" }], positiveEvidence: 0.72, conflictEvidence: 0, totalWeight: 2, evidence: [evidence] };
const candidateSummary = { candidateId: candidate.candidateId, bRowId: candidate.bRowId, rank: 1, matchScore: 0.72, band: "needs_review" as const, collision: false, strongContradiction: false, strongestPositive: { mappingId: "name", label: "Organization name", evidenceClass: "partial_agreement" as const, contribution: 0.72 }, strongestContradiction: null, humanDecision: null };
const mapping = { mappingId: "name", label: "Organization name", aColumn: "name", bColumn: "organization", useForMatching: true, includeInMerge: false, normalizer: "text" as const };
const comparison = { mappingId: "status", label: "Status", aColumn: "status", bColumn: "status", useForMatching: false, includeInMerge: true, normalizer: "text" as const };

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
    mappingVersion: "confirmed-mappings-v3", semanticMappingProvenance: null,
    matcherVersion: "explainable-matcher-v0.3.0", summary: { matched: 2, needsReview: 1, onlyA: 3, onlyB: 4 },
    matcherProvenance: { matcherVersion: "explainable-matcher-v0.3.0", candidateEngineVersion: "candidate-engine-v0.4.0", blockingNormalizationVersion: "blocking-normalization-v0.1.0", featurePipelineVersion: "feature-pipeline-v0.2.0", matcherConfigVersion: "matcher-config-v0.3.0", matcherConfig: { frozen: true } },
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
  return { contractVersion: "1.0.0", runId: "run-1", items: [{ aRowId: "A1", topCandidateId: candidate.candidateId, topBRowId: "B1", topMatchScore: 0.72, runnerUpMargin: 0.2, candidateCount: 1, strongestPositive: candidateSummary.strongestPositive, strongestContradiction: null, collision: false, collisionARowIds: [], strongContradiction: false, state: "needs_review", deferred: false, humanDecision: null, matcherVersion: "explainable-matcher-v0.3.0", sourceOrder: 0, aIdentity: { name: "Acme Corp" }, topBIdentity: { organization: "Acme Corporation" }, candidates: [candidateSummary] }], page: { offset: 0, limit: 50, total: 1, returned: 1, nextOffset: null, previousOffset: null }, progress: { total: 1, reviewed: 0, remaining: 1, deferred: 0 }, filter: "unresolved", sort: "ambiguity", query: "" };
}

function candidateDetail() {
  return { contractVersion: "1.0.0", runId: "run-1", candidate, alternatives: [candidateSummary], reviewState: "needs_review", deferred: false, collisionARowIds: [], effectiveCollisionARowIds: [], humanDecision: null, conflicts: [], matcherVersion: "explainable-matcher-v0.3.0", candidateEngineVersion: "candidate-engine-v0.4.0" };
}

function proposal(overrides: Partial<SemanticMappingProposal["suggestions"][number]> = {}): SemanticMappingProposal {
  return {
    contractVersion: "3.0.0", proposalId: "proposal-1", runId: "run-1",
    provenance: { provider: "openai", model: "test-model", promptVersion: "semantic-mapping-prompt-v3", schemaVersion: "3.0.0", requestVersion: "metadata-first-v3", responseId: "response-1" },
    suggestions: [{ suggestionId: "suggestion-1", leftColumn: "name", rightColumn: "organization", relation: "equivalent", useForMatching: true, includeInMerge: true, sourceSpecific: false, semanticFamily: "name_or_title", confidence: 0.94, reason: "Both columns appear to contain organization names.", normalizationHints: ["casefold"], status: "pending", finalMapping: null, ...overrides }],
    unmappedLeft: ["status"], unmappedRight: ["status"], createdAt: "2026-08-31T12:00:00.000Z",
  };
}

function suggestionResponse(value = proposal(), confirmedMappings: MappingSuggestionResponse["confirmedMappings"] = []): MappingSuggestionResponse {
  return { contractVersion: "3.0.0", proposal: value, confirmedMappings };
}

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

describe("Samewise vertical slice", () => {
  it("offers same-origin sample downloads only for an empty run", () => {
    const empty = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const { unmount } = render(<App initialRun={empty} initialScreen="upload" />);
    expect(screen.getByRole("button", { name: "Try sample data" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download sample Dataset A CSV" })).toHaveAttribute("href", "/samples/samewise_sample_vendors_a.csv");
    expect(screen.getByRole("link", { name: "Download sample Dataset B CSV" })).toHaveAttribute("href", "/samples/samewise_sample_vendors_b.csv");
    unmount();
    render(<App initialRun={runView({ stage: "upload", datasets: { A: profile("A") }, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null })} initialScreen="upload" />);
    expect(screen.queryByRole("button", { name: "Try sample data" })).not.toBeInTheDocument();
  });

  it("loads both sample assets before uploading normal File objects through the shared pair path", async () => {
    const empty = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const afterA = runView({ stage: "upload", datasets: { A: { ...profile("A"), originalFilename: "samewise_sample_vendors_a.csv" } }, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const complete = runView({ stage: "profile", datasets: { A: afterA.datasets.A, B: { ...profile("B"), originalFilename: "samewise_sample_vendors_b.csv" } }, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const order: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); order.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("_a.csv")) return new Response("source_record_id,company_name\nA-1,Example A\n", { status: 200 });
      if (url.endsWith("_b.csv")) return new Response("source_record_id,company_name\nB-1,Example B\n", { status: 200 });
      if (url.endsWith("/datasets/A")) return new Response(JSON.stringify(afterA), { status: 201, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/datasets/B")) return new Response(JSON.stringify(complete), { status: 201, headers: { "Content-Type": "application/json" } });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={empty} initialScreen="upload" />);
    fireEvent.click(screen.getByRole("button", { name: "Try sample data" }));
    expect(await screen.findByRole("heading", { name: "Your files are ready." })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Using synthetic sample data");
    expect(order.slice(0, 2)).toEqual(["GET /samples/samewise_sample_vendors_a.csv", "GET /samples/samewise_sample_vendors_b.csv"]);
    const uploadCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/datasets/"));
    expect(uploadCalls).toHaveLength(2);
    expect(uploadCalls[0]?.[1]?.body).toBeInstanceOf(File);
    expect((uploadCalls[0]?.[1]?.body as File).name).toBe("samewise_sample_vendors_a.csv");
    expect(uploadCalls[1]?.[1]?.body).toBeInstanceOf(File);
    expect((uploadCalls[1]?.[1]?.body as File).name).toBe("samewise_sample_vendors_b.csv");
  });

  it("does not mutate selections or upload when either sample asset fails", async () => {
    const empty = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("_a.csv")
      ? new Response("source_record_id,company_name\nA-1,Example A\n", { status: 200 })
      : new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={empty} initialScreen="upload" />);
    fireEvent.click(screen.getByRole("button", { name: "Try sample data" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sample data couldn't be loaded");
    expect(screen.queryByText("samewise_sample_vendors_a.csv")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/datasets/"))).toBe(false);
    expect(screen.getByRole("button", { name: "Upload & profile" })).toBeEnabled();
  });

  it("requires confirmation before replacing a manual selection and Cancel preserves it", () => {
    const empty = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={empty} initialScreen="upload" />);
    fireEvent.change(screen.getByLabelText("Dataset A CSV"), { target: { files: [new File(["id\n1"], "mine.csv", { type: "text/csv" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Try sample data" }));
    expect(screen.getByRole("dialog", { name: "Replace your selected files with the sample datasets?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("mine.csv")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the sample pair after confirmed replacement", async () => {
    const empty = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const afterA = runView({ stage: "upload", datasets: { A: { ...profile("A"), originalFilename: "samewise_sample_vendors_a.csv" } }, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const complete = runView({ stage: "profile", datasets: { A: afterA.datasets.A, B: { ...profile("B"), originalFilename: "samewise_sample_vendors_b.csv" } }, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("_a.csv")) return new Response("id,name\nA-1,Sample A\n");
      if (url.endsWith("_b.csv")) return new Response("id,name\nB-1,Sample B\n");
      return new Response(JSON.stringify(url.endsWith("/datasets/A") ? afterA : complete), { status: 201, headers: { "Content-Type": "application/json" } });
    }));
    render(<App initialRun={empty} initialScreen="upload" />);
    fireEvent.change(screen.getByLabelText("Dataset A CSV"), { target: { files: [new File(["id\n1"], "mine.csv", { type: "text/csv" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Try sample data" }));
    fireEvent.click(screen.getByRole("button", { name: "Use sample data" }));
    expect(await screen.findByText("Using synthetic sample data.")).toBeInTheDocument();
    expect(screen.getByText("samewise_sample_vendors_a.csv")).toBeInTheDocument();
    expect(screen.getByText("samewise_sample_vendors_b.csv")).toBeInTheDocument();
  });

  it("keeps normal upload recovery truthful when the API is unavailable", async () => {
    const empty = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "The API is unavailable." } }), { status: 503, headers: { "Content-Type": "application/json" } })));
    render(<App initialRun={empty} initialScreen="upload" />);
    fireEvent.change(screen.getByLabelText("Dataset A CSV"), { target: { files: [new File(["id\n1"], "a.csv", { type: "text/csv" })] } });
    fireEvent.change(screen.getByLabelText("Dataset B CSV"), { target: { files: [new File(["id\n2"], "b.csv", { type: "text/csv" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload & profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The API is unavailable");
    expect(screen.getByRole("button", { name: "Upload & profile" })).toBeEnabled();
    expect(screen.getByText("a.csv")).toBeInTheDocument();
    expect(screen.getByText("b.csv")).toBeInTheDocument();
  });

  it("guards sample loading synchronously against a double click", () => {
    const empty = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={empty} initialScreen="upload" />);
    const button = screen.getByRole("button", { name: "Try sample data" });
    fireEvent.click(button); fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("synchronizes an authoritative Dataset A upload when Dataset B fails", async () => {
    const empty = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const afterA = runView({ stage: "upload", datasets: { A: profile("A") }, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/datasets/A")) return new Response(JSON.stringify(afterA), { status: 201, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/datasets/B")) return new Response(JSON.stringify({ error: { message: "Dataset B could not be profiled." } }), { status: 400, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/runs/run-1")) return new Response(JSON.stringify(afterA), { status: 200, headers: { "Content-Type": "application/json" } });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={empty} initialScreen="upload" />);
    fireEvent.change(screen.getByLabelText("Dataset A CSV"), { target: { files: [new File(["id\n1"], "a.csv", { type: "text/csv" })] } });
    fireEvent.change(screen.getByLabelText("Dataset B CSV"), { target: { files: [new File(["id\n2"], "b.csv", { type: "text/csv" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload & profile" }));
    expect(await screen.findByRole("heading", { name: "Source files are locked for this run" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Start a new reconciliation and retry");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/runs/run-1/datasets/A", "/api/runs/run-1/datasets/B", "/api/runs/run-1",
    ]);
  });

  it("opens Merge values from a completed zero-case review without creating another run", async () => {
    const empty = { ...reviewPage(), items: [], page: { ...reviewPage().page, total: 0, returned: 0 }, progress: { total: 0, reviewed: 0, remaining: 0, deferred: 0 } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(empty), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={runView({ reviewProgress: { total: 0, reviewed: 0, remaining: 0, deferred: 0 }, summary: { matched: 1, needsReview: 0, onlyA: 0, onlyB: 0 }, trustedExportReadiness: { ready: true, unresolvedIdentityCount: 0, unresolvedConflictCount: 0, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: [] } })} initialScreen="review" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue to Merge values" }));
    expect(await screen.findByRole("heading", { name: "No conflicting values need resolution" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("run-1"))).toBe(true);
  });
  it("navigates between reconciliation and the dedicated Matching quality product", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<App initialRun={runView()} initialScreen="results" />);
    fireEvent.click(screen.getByText("Advanced"));
    fireEvent.click(screen.getByRole("button", { name: "Matching quality" }));
    expect(screen.getByRole("button", { name: "Matching quality" })).toHaveAttribute("aria-current", "page");
    expect(document.querySelector(".workspace.evaluation-layout")).toBeInTheDocument();
    expect(await screen.findByText("offline")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reconciliation" }));
    expect(screen.getByRole("heading", { name: "Matching complete." })).toBeInTheDocument();
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

  it("remounts file inputs for a fresh run so the same files can be selected again", async () => {
    const current = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const fresh = { ...current, runId: "run-2" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(fresh), { status: 201, headers: { "Content-Type": "application/json" } })));
    render(<App initialRun={current} initialScreen="upload" />);
    const originalInput = screen.getByLabelText("Dataset A CSV");
    fireEvent.change(originalInput, { target: { files: [new File(["id\n1"], "same-a.csv", { type: "text/csv" })] } });
    fireEvent.click(screen.getByRole("button", { name: "New reconciliation" }));
    await waitFor(() => expect(screen.getByLabelText("Dataset A CSV")).not.toBe(originalInput));
    expect(screen.queryByText("same-a.csv")).not.toBeInTheDocument();
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
    expect(screen.getByRole("heading", { name: "Your files are ready." })).toBeInTheDocument();
    expect(screen.getByText("a.csv")).toBeInTheDocument();
    expect(screen.getAllByText("Acme")).toHaveLength(2);
    expect(screen.getAllByText(/1 rows · SHA-256/)).toHaveLength(2);
  });

  it("blocks matching until at least one matching field is selected", () => {
    render(<App initialRun={runView({ mappings: [] })} initialScreen="mapping" />);
    expect(screen.getByRole("button", { name: "Confirm setup & run matching" })).toBeDisabled();
    expect(screen.getByText("Choose at least one field Samewise can use to look for the same record.")).toBeInTheDocument();
  });

  it("presents matching and merge participation as independent choices", () => {
    render(<App initialRun={runView()} initialScreen="mapping" />);
    expect(screen.getByText(/A field can do both/)).toBeInTheDocument();
    expect(screen.getAllByLabelText("Use to match")).toHaveLength(2);
    expect(screen.getAllByLabelText("Keep in result")).toHaveLength(2);
  });

  it("shows AI suggestion loading, evidence, advisory confidence, and no auto-confirmation", async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    render(<App initialRun={runView({ mappings: [] })} initialScreen="mapping" />);
    fireEvent.click(screen.getByRole("button", { name: "Get recommended setup" }));
    expect(screen.getByText("Reviewing schema metadata…")).toBeInTheDocument();
    resolveFetch(new Response(JSON.stringify(suggestionResponse()), { status: 201, headers: { "Content-Type": "application/json" } }));
    expect(await screen.findByText("Both columns appear to contain organization names.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Samewise found 1 corresponding fields." })).toBeInTheDocument();
    expect(screen.getByText(/Recommendations stay inactive until you confirm them/)).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Organization name")).not.toBeInTheDocument();
  });

  it("accepts a suggestion only after a user action and renders the confirmed mapping", async () => {
    const acceptedMapping = { ...mapping, mappingId: "mapping-suggestion-1", label: "name" };
    const acceptedProposal = proposal({ status: "accepted", finalMapping: acceptedMapping });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(suggestionResponse()), { status: 201, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(suggestionResponse(acceptedProposal, [acceptedMapping])), { status: 200, headers: { "Content-Type": "application/json" } })));
    render(<App initialRun={runView({ mappings: [] })} initialScreen="mapping" />);
    fireEvent.click(screen.getByRole("button", { name: "Get recommended setup" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use recommended setup" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Recommended setup added");
    expect(screen.getByLabelText("Mapping label")).toHaveValue("name");
  });

  it("keeps manual setup available without accepting a recommendation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(suggestionResponse()), { status: 201, headers: { "Content-Type": "application/json" } })));
    render(<App initialRun={runView({ mappings: [] })} initialScreen="mapping" />);
    fireEvent.click(screen.getByRole("button", { name: "Get recommended setup" }));
    await screen.findByRole("button", { name: "Use recommended setup" });
    fireEvent.click(screen.getByRole("button", { name: "+ Add manual mapping" }));
    expect(screen.getByLabelText("Mapping label")).toBeInTheDocument();
  });

  it("allows a confirmed recommendation to be remapped and used in both phases", async () => {
    const acceptedMapping = { ...mapping, mappingId: "mapping-suggestion-1", label: "name", includeInMerge: true };
    const acceptedProposal = proposal({ status: "accepted", finalMapping: acceptedMapping });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(suggestionResponse()), { status: 201, headers: { "Content-Type": "application/json" } })).mockResolvedValueOnce(new Response(JSON.stringify(suggestionResponse(acceptedProposal, [acceptedMapping])), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={runView({ mappings: [] })} initialScreen="mapping" />);
    fireEvent.click(screen.getByRole("button", { name: "Get recommended setup" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use recommended setup" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Recommended setup added");
    if (!screen.getByText("Advanced setup").parentElement?.hasAttribute("open")) fireEvent.click(screen.getByText("Advanced setup"));
    fireEvent.change(screen.getByLabelText("Dataset B column"), { target: { value: "status" } });
    expect(screen.getByLabelText("Use to match")).toBeChecked();
    expect(screen.getByLabelText("Keep in result")).toBeChecked();
    expect(screen.getByLabelText("Dataset B column")).toHaveValue("status");
  });

  it("keeps manual mapping available when AI is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "ai_missing_key", message: "AI suggestions unavailable. You can continue mapping columns manually." } }), { status: 503, headers: { "Content-Type": "application/json" } })));
    render(<App initialRun={runView({ mappings: [] })} initialScreen="mapping" />);
    fireEvent.click(screen.getByRole("button", { name: "Get recommended setup" }));
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
    expect(screen.getByText("Matched automatically / confirmed").parentElement).toHaveTextContent("2");
    expect(screen.getByText("Need your review").parentElement).toHaveTextContent("1");
    expect(screen.getByText("No match found in Dataset B").parentElement).toHaveTextContent("3");
    expect(screen.getByText("No match found in Dataset A").parentElement).toHaveTextContent("4");
    fireEvent.click(await screen.findByRole("button", { name: /A1.*B1/ }));
    expect(await screen.findByRole("heading", { name: "Could A1 and B1 be the same entity?" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Show technical evidence")[0]!);
    expect(screen.getAllByText("0.720").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText("Show technical evidence")[1]!);
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
    expect(await screen.findByRole("heading", { name: "Could these be the same entity?" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1");
    expect(window.location.search).toContain("run=run-1");
    expect(window.location.search).toContain("screen=review");
  });

  it("keeps the reconciliation report available while trusted merged output is blocked", () => {
    render(<App initialRun={runView()} initialScreen="export" />);
    expect(screen.getByRole("heading", { name: "Identity review isn't finished" })).toBeInTheDocument();
    expect(screen.getByText("Reconciled data").parentElement).toHaveTextContent("Blocked");
    fireEvent.click(screen.getByText("Audit & technical files"));
    expect(screen.getByRole("button", { name: "Download reconciliation report" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Download reconciled data" })).toBeDisabled();
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
    render(<App initialRun={runView({ reviewProgress: { total: 1, reviewed: 1, remaining: 0, deferred: 0 }, conflictSummary: { total: 2, resolved: 2, unresolved: 0, manualDecisions: 1, preservedBoth: 1 }, trustedExportReadiness: { ready: true, unresolvedIdentityCount: 0, unresolvedConflictCount: 0, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: [] } })} initialScreen="export" />);
    expect(screen.getByRole("heading", { name: "Ready to export" })).toBeInTheDocument();
    expect(screen.getByText("Reconciled data").parentElement).toHaveTextContent("Ready");
    expect(screen.getByRole("button", { name: "Download reconciled data" })).toBeEnabled();
    expect(screen.getByText(/1 matched entity · 1 human identity decision · 1 difference handled by rules · 1 manual value decision · 0 unfinished decisions/)).toBeInTheDocument();
    expect(screen.getByText("Some fields intentionally preserve both source values.")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps trusted output blocked with an exact unresolved field-conflict reason", () => {
    render(<App initialRun={runView({ reviewProgress: { total: 1, reviewed: 1, remaining: 0, deferred: 0 }, trustedExportReadiness: { ready: false, unresolvedIdentityCount: 0, unresolvedConflictCount: 3, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: ["3 comparison-field conflict(s) remain unresolved."] } })} initialScreen="export" />);
    expect(screen.getByRole("heading", { name: "Field conflicts still need resolution" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("3 comparison-field conflict(s) remain unresolved.");
    fireEvent.click(screen.getByText("Audit & technical files"));
    expect(screen.getByRole("button", { name: "Download reconciliation report" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Download reconciled data" })).toBeDisabled();
  });

  it("marks reconciled output as identity-only when no merge mappings were configured", () => {
    render(<App initialRun={runView({ mappings: [mapping], reviewProgress: { total: 0, reviewed: 0, remaining: 0, deferred: 0 }, trustedExportReadiness: { ready: true, unresolvedIdentityCount: 0, unresolvedConflictCount: 0, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: [] } })} initialScreen="export" />);
    expect(screen.getByRole("heading", { name: "Identity resolved · no merge fields configured" })).toBeInTheDocument();
    expect(screen.getByText("Reconciled data").parentElement).toHaveTextContent("Ready · identity only");
    expect(screen.getByText(/contains no merged business fields/)).toBeInTheDocument();
  });
});
