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

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

function stubBrowserDownloads() {
  class DownloadURL extends URL {
    static createObjectURL = vi.fn(() => "blob:samewise-test");
    static revokeObjectURL = vi.fn();
  }
  vi.stubGlobal("URL", DownloadURL);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  return { createObjectURL: DownloadURL.createObjectURL, revokeObjectURL: DownloadURL.revokeObjectURL, click };
}

function readyExportRun(): RunSummary {
  return runView({
    trustedExportReadiness: { ready: true, unresolvedIdentityCount: 0, unresolvedConflictCount: 0, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: [] },
    reviewProgress: { total: 1, reviewed: 1, remaining: 0, deferred: 0 },
    conflictSummary: { total: 1, resolved: 1, unresolved: 0 },
  });
}



describe("Samewise vertical slice", () => {
  it("SW-028 refreshes authoritative run after a stale review 409 without retrying the identity decision", async () => {
    const current = runView({stage:"review"});
    const refreshed = runView({
      stage:"review",
      reviewProgress:{total:1,reviewed:1,remaining:0,deferred:0},
      summary:{matched:0,needsReview:0,onlyA:3,onlyB:4},
    });
    const requests: string[] = [];
    vi.stubGlobal("fetch",vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url=String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/review?")) return new Response(JSON.stringify(reviewPage()),{status:200});
      if (url.endsWith("/candidates/candidate-1-1") && !init?.method) {
        return new Response(JSON.stringify(candidateDetail()),{status:200});
      }
      if (url.endsWith("/candidates/candidate-1-1/decisions")) {
        return new Response(JSON.stringify({error:{code:"decision_exists",message:"This candidate already has a recorded decision."}}),{status:409});
      }
      if (url==="/api/runs/run-1" && !init?.method) {
        return new Response(JSON.stringify(refreshed),{status:200});
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<App initialRun={current} initialScreen="review"/>);
    fireEvent.click(await screen.findByRole("button",{name:"Different entities"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("already has a recorded decision");
    expect(await screen.findByRole("heading",{name:"Identity review complete"})).toBeInTheDocument();
    expect(requests.filter(request=>request.endsWith("/candidates/candidate-1-1/decisions"))).toHaveLength(1);
    expect(requests).toContain("GET /api/runs/run-1");
  });

  it("opens an accessible mobile menu, exposes workflow state, and closes after navigation", async () => {
    render(<App initialRun={runView()} initialScreen="results" />);
    const menuButton = screen.getByRole("button", { name: "Menu" });
    expect(menuButton).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(menuButton);
    const dialog = await screen.findByRole("dialog", { name: "Samewise menu" });
    expect(menuButton).toHaveAttribute("aria-expanded", "true");
    expect(dialog).toHaveTextContent("Review matches");
    expect(screen.getByRole("button", { name: /Review matches Current step/ })).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("button", { name: /Merge values Not yet available/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Match setup Completed/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Samewise menu" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Set up matching." })).toBeInTheDocument();

    fireEvent.click(menuButton);
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    await waitFor(() => expect(menuButton).toHaveFocus());
  });

  it("SW-036 makes the public-demo upload boundary visible before and after source locking", () => {
    const empty = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const { unmount } = render(<App initialRun={empty} initialScreen="upload" />);
    const notice = screen.getByRole("note", { name: "Public demo data notice" });
    expect(notice).toHaveTextContent("Public demo — use non-sensitive CSVs.");
    expect(notice).toHaveTextContent("Uploaded records are processed on Samewise's server.");
    expect(notice).toHaveTextContent("no sign-in or guaranteed deletion schedule");
    expect(screen.getByRole("button", { name: "Upload & profile" })).toBeInTheDocument();
    unmount();

    const locked = runView({ stage: "upload", datasets: { A: profile("A") }, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    render(<App initialRun={locked} initialScreen="upload" />);
    expect(screen.getByRole("note", { name: "Public demo data notice" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Source files are locked for this run" })).toBeInTheDocument();
  });

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

  it.each([
    { scenario: "empty A", side: "A", bytes: 0, expected: "Dataset A is empty" },
    { scenario: "empty B", side: "B", bytes: 0, expected: "Dataset B is empty" },
    { scenario: "oversized A", side: "A", bytes: 2 * 1024 * 1024 + 1, expected: "Dataset A exceeds the 2 MiB file limit" },
    { scenario: "oversized B", side: "B", bytes: 2 * 1024 * 1024 + 1, expected: "Dataset B exceeds the 2 MiB file limit" },
  ])("SW-039 rejects $scenario before sending either immutable source", ({ side, bytes, expected }) => {
    const empty = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={empty} initialScreen="upload" />);
    const valid = new File(["id\n1"], "valid.csv", { type: "text/csv" });
    const invalid = new File([new Uint8Array(bytes)], "invalid.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Dataset A CSV"), { target: { files: [side === "A" ? invalid : valid] } });
    fireEvent.change(screen.getByLabelText("Dataset B CSV"), { target: { files: [side === "B" ? invalid : valid] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload & profile" }));
    expect(screen.getByRole("alert")).toHaveTextContent(expected);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Source files are locked for this run" })).not.toBeInTheDocument();
  });

  it("SW-039 allows a CSV exactly at the 2 MiB boundary", async () => {
    const empty = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const afterA = runView({ stage: "upload", datasets: { A: profile("A") }, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const complete = runView({ stage: "profile", datasets: { A: afterA.datasets.A, B: profile("B") }, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith("/datasets/A") ? afterA : complete), {
      status: 201, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={empty} initialScreen="upload" />);
    fireEvent.change(screen.getByLabelText("Dataset A CSV"), { target: { files: [new File([new Uint8Array(2 * 1024 * 1024)], "at-limit.csv", { type: "text/csv" })] } });
    fireEvent.change(screen.getByLabelText("Dataset B CSV"), { target: { files: [new File(["id\n2"], "small.csv", { type: "text/csv" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload & profile" }));
    expect(await screen.findByRole("heading", { name: "Your files are ready." })).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/runs/run-1/datasets/A", "/api/runs/run-1/datasets/B",
    ]);
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

  it("SW-040 preserves Dataset A and offers missing-side recovery when B fails", async () => {
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
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a corrected CSV for the missing dataset");
    expect(screen.getByRole("status")).toHaveTextContent("Dataset A is saved as a.csv");
    expect(screen.getByRole("button", { name: "Upload remaining Dataset B" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload remaining Dataset A" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/runs/run-1/datasets/A", "/api/runs/run-1/datasets/B", "/api/runs/run-1",
    ]);
  });

  it("SW-040 retries only Dataset B after its first profiling failure", async () => {
    const empty = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const afterA = runView({ ...empty, datasets: { A: profile("A") } });
    const completed = runView({ ...empty, stage: "profile", datasets: { A: profile("A"), B: profile("B") } });
    let bAttempts = 0;
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/datasets/A")) return new Response(JSON.stringify(afterA), { status: 201 });
      if (url.endsWith("/datasets/B")) {
        bAttempts++;
        if (bAttempts === 1) return new Response(JSON.stringify({ error: { message: "Invalid CSV header." } }), { status: 400 });
        expect((init?.body as File).name).toBe("corrected-b.csv");
        return new Response(JSON.stringify(completed), { status: 201 });
      }
      if (url.endsWith("/api/runs/run-1")) return new Response(JSON.stringify(afterA), { status: 200 });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={empty} initialScreen="upload" />);
    fireEvent.change(screen.getByLabelText("Dataset A CSV"), { target: { files: [new File(["id\n1"], "a.csv", { type: "text/csv" })] } });
    fireEvent.change(screen.getByLabelText("Dataset B CSV"), { target: { files: [new File(["bad"], "bad-b.csv", { type: "text/csv" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload & profile" }));
    expect(await screen.findByRole("button", { name: "Upload remaining Dataset B" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Dataset B CSV"), { target: { files: [new File(["id\n2"], "corrected-b.csv", { type: "text/csv" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload remaining Dataset B" }));
    expect(await screen.findByRole("heading", { name: "Your files are ready." })).toBeInTheDocument();
    expect(requests).toEqual([
      "POST /api/runs/run-1/datasets/A", "POST /api/runs/run-1/datasets/B", "GET /api/runs/run-1",
      "POST /api/runs/run-1/datasets/B",
    ]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SW-040 accepts an A-only recovery when Dataset B is already saved", async () => {
    const partial = runView({ stage: "upload", datasets: { B: profile("B") }, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const complete = runView({ ...partial, stage: "profile", datasets: { A: profile("A"), B: profile("B") } });
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/datasets/A")) return new Response(JSON.stringify(complete), { status: 201 });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<App initialRun={partial} initialScreen="upload" />);
    expect(screen.getByRole("status")).toHaveTextContent("Dataset B is saved as b.csv");
    fireEvent.change(screen.getByLabelText("Dataset A CSV"), { target: { files: [new File(["id\n1"], "a.csv", { type: "text/csv" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload remaining Dataset A" }));
    expect(await screen.findByRole("heading", { name: "Your files are ready." })).toBeInTheDocument();
    expect(requests).toEqual(["POST /api/runs/run-1/datasets/A"]);
  });

  it.each([
    { name: "missing", file: null, expected: "Choose a CSV file for Dataset B" },
    { name: "wrong extension", file: new File(["id\n1"], "bad.txt"), expected: "Dataset B must be a CSV file" },
    { name: "empty", file: new File([], "empty.csv"), expected: "Dataset B is empty" },
    { name: "oversized", file: new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.csv"), expected: "Dataset B exceeds the 2 MiB file limit" },
  ])("SW-040 rejects $name recovery before sending a network request", ({ file, expected }) => {
    const partial = runView({ stage: "upload", datasets: { A: profile("A") }, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={partial} initialScreen="upload" />);
    if (file) fireEvent.change(screen.getByLabelText("Dataset B CSV"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload remaining Dataset B" }));
    expect(screen.getByRole("alert")).toHaveTextContent(expected);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("a.csv")).toBeInTheDocument();
  });

  it("SW-040 reconciles a lost success response before offering another upload", async () => {
    const partial = runView({ stage: "upload", datasets: { A: profile("A") }, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const completed = runView({ ...partial, stage: "profile", datasets: { A: profile("A"), B: profile("B") } });
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/datasets/B")) throw new Error("Connection lost after upload");
      if (url.endsWith("/api/runs/run-1")) return new Response(JSON.stringify(completed), { status: 200 });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<App initialRun={partial} initialScreen="upload" />);
    fireEvent.change(screen.getByLabelText("Dataset B CSV"), { target: { files: [new File(["id\n2"], "b.csv") ] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload remaining Dataset B" }));
    expect(await screen.findByRole("heading", { name: "Your files are ready." })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(requests).toEqual(["POST /api/runs/run-1/datasets/B", "GET /api/runs/run-1"]);
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

  it.each(["A", "B"] as const)("SW-041 clears native Dataset %s input to permit reselecting the same path", (side) => {
    const empty = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    render(<App initialRun={empty} initialScreen="upload" />);
    const input = screen.getByLabelText(`Dataset ${side} CSV`) as HTMLInputElement;
    const assignments: string[] = [];
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "",
      set: (value: string) => { assignments.push(value); },
    });
    fireEvent.change(input, { target: { files: [new File(["before"], "same.csv")] } });
    expect(screen.getByText("same.csv")).toBeInTheDocument();
    expect(assignments).toEqual([""]);
    fireEvent.click(screen.getByRole("button", { name: `Replace Dataset ${side} CSV` }));
    fireEvent.change(input, { target: { files: [new File(["after"], "same.csv")] } });
    expect(assignments).toEqual(["", ""]);
    expect(screen.getByText("same.csv")).toBeInTheDocument();
  });

  it("SW-041 clears stale preflight guidance after a new source selection", () => {
    const empty = runView({ stage: "upload", datasets: {}, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={empty} initialScreen="upload" />);
    fireEvent.click(screen.getByRole("button", { name: "Upload & profile" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose one CSV file");
    fireEvent.change(screen.getByLabelText("Dataset A CSV"), { target: { files: [new File(["id\n1"], "a.csv")] } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("SW-041 retries a corrected Dataset B with the same filename and keeps saved A immutable", async () => {
    const partial = runView({ stage: "upload", datasets: { A: profile("A") }, mappings: [], matcherVersion: null, matcherProvenance: null, summary: null });
    const completed = runView({ ...partial, stage: "profile", datasets: { A: profile("A"), B: profile("B") } });
    const requests: string[] = [];
    const corrected = new File(["id\nB-IV-301"], "corrected.csv", { type: "text/csv" });
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).endsWith("/datasets/B")) {
        expect(init?.body).toBe(corrected);
        return new Response(JSON.stringify(completed), { status: 201 });
      }
      throw new Error(`Unexpected request ${String(url)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialRun={partial} initialScreen="upload" />);
    const input = screen.getByLabelText("Dataset B CSV");
    fireEvent.change(input, { target: { files: [new File([], "corrected.csv", { type: "text/csv" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload remaining Dataset B" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Dataset B is empty");
    fireEvent.click(screen.getByRole("button", { name: "Replace Dataset B CSV" }));
    fireEvent.change(input, { target: { files: [corrected] } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upload remaining Dataset B" }));
    expect(await screen.findByRole("heading", { name: "Your files are ready." })).toBeInTheDocument();
    expect(requests).toEqual(["POST /api/runs/run-1/datasets/B"]);
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

  it("SW-032 pins later browser downloads to the first exact-state export response", async () => {
    const downloads = stubBrowserDownloads();
    const pin = "a".repeat(64);
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response("export bytes", { status: 200, headers: {
        "X-Samewise-Export-Snapshot": pin,
        "Content-Disposition": 'attachment; filename="samewise-run-1-report.csv"',
      } });
    }));
    render(<App initialRun={readyExportRun()} initialScreen="export" />);
    fireEvent.click(screen.getByText("Audit & technical files"));
    fireEvent.click(screen.getByRole("button", { name: "Download provenance manifest" }));
    await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Download reconciliation report" }));
    await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Download reconciled data" }));
    await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(3));
    expect(requests).toEqual([
      "/api/runs/run-1/manifest",
      `/api/runs/run-1/export?expectedSnapshot=${pin}`,
      `/api/runs/run-1/trusted-export?expectedSnapshot=${pin}`,
    ]);
    expect(downloads.createObjectURL).toHaveBeenCalledTimes(3);
    expect(downloads.revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it("SW-032 stops stale downloads on 409 and requires a fresh user action to restart", async () => {
    const downloads = stubBrowserDownloads();
    const firstPin = "b".repeat(64);
    const newPin = "c".repeat(64);
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      if (requests.length === 2) {
        return new Response(JSON.stringify({ error: { code: "stale_export_snapshot", message: "stale" } }), {
          status: 409, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("export bytes", { status: 200, headers: {
        "X-Samewise-Export-Snapshot": requests.length === 1 ? firstPin : newPin,
      } });
    }));
    render(<App initialRun={runView()} initialScreen="export" />);
    fireEvent.click(screen.getByText("Audit & technical files"));
    fireEvent.click(screen.getByRole("button", { name: "Download reconciliation report" }));
    await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Download provenance manifest" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Download all report files again");
    expect(downloads.click).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    await waitFor(() => expect(screen.getByRole("button", { name: "Download provenance manifest" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Download provenance manifest" }));
    await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(2));
    expect(requests).toEqual([
      "/api/runs/run-1/export",
      `/api/runs/run-1/manifest?expectedSnapshot=${firstPin}`,
      "/api/runs/run-1/manifest",
    ]);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("SW-032 rejects missing snapshot headers after pinning and supports legacy first downloads", async () => {
    const downloads = stubBrowserDownloads();
    const pin = "d".repeat(64);
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      if (requests.length === 2) return new Response("legacy bytes", { status: 200 });
      return new Response("export bytes", { status: 200, headers: requests.length === 1 ? { "X-Samewise-Export-Snapshot": pin } : {} });
    }));
    render(<App initialRun={runView()} initialScreen="export" />);
    fireEvent.click(screen.getByText("Audit & technical files"));
    fireEvent.click(screen.getByRole("button", { name: "Download reconciliation report" }));
    await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Download provenance manifest" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Export snapshot verification is unavailable");
    expect(downloads.click).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Download provenance manifest" }));
    await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(2));
    expect(requests).toEqual([
      "/api/runs/run-1/export",
      `/api/runs/run-1/manifest?expectedSnapshot=${pin}`,
      "/api/runs/run-1/manifest",
    ]);
  });

  it("SW-032 rejects a different 200-response snapshot SHA without downloading mixed bytes", async () => {
    const downloads = stubBrowserDownloads();
    const first = "e".repeat(64);
    const second = "f".repeat(64);
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response("export bytes", { status: 200, headers: {
        "X-Samewise-Export-Snapshot": requests.length === 1 ? first : second,
      } });
    }));
    render(<App initialRun={runView()} initialScreen="export" />);
    fireEvent.click(screen.getByText("Audit & technical files"));
    fireEvent.click(screen.getByRole("button", { name: "Download reconciliation report" }));
    await waitFor(() => expect(downloads.click).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Download provenance manifest" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Export snapshot verification is unavailable or has changed");
    expect(downloads.click).toHaveBeenCalledTimes(1);
    expect(requests).toEqual(["/api/runs/run-1/export", `/api/runs/run-1/manifest?expectedSnapshot=${first}`]);
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
