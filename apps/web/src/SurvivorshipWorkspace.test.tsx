import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSummary } from "@samewise/contracts";
import { SurvivorshipWorkspace } from "./SurvivorshipWorkspace.js";

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return { contractVersion: "1.0.0", projectionVersion: "1.0.0", runId: "run-1", stage: "resolution", datasets: {}, mappings: [
    { mappingId: "name", label: "Name", aColumn: "name", bColumn: "name", useForMatching: true, includeInMerge: false, normalizer: "text" },
    { mappingId: "phone", label: "Phone", aColumn: "phone", bColumn: "phone", useForMatching: false, includeInMerge: true, normalizer: "phone" },
    { mappingId: "email", label: "Email", aColumn: "email", bColumn: "email", useForMatching: false, includeInMerge: true, normalizer: "email" },
  ], mappingVersion: "confirmed-mappings-v3", semanticMappingProvenance: null, matcherVersion: "explainable-matcher-v0.3.0", matcherProvenance: { matcherVersion: "explainable-matcher-v0.3.0", candidateEngineVersion: "candidate-engine-v0.4.0", blockingNormalizationVersion: "blocking-normalization-v0.1.0", featurePipelineVersion: "feature-pipeline-v0.2.0", matcherConfigVersion: "matcher-config-v0.3.0", matcherConfig: {} }, summary: { matched: 1, needsReview: 0, onlyA: 0, onlyB: 0 }, survivorshipPolicy: null, trustedExportReadiness: { ready: false, unresolvedIdentityCount: 0, unresolvedConflictCount: 2, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: ["conflicts"] }, reviewProgress: { total: 0, reviewed: 0, remaining: 0, deferred: 0 }, reviewUndo: null, conflictSummary: { total: 2, resolved: 0, unresolved: 2, rulesApplied: false, fields: [
    { mappingId: "phone", label: "Phone", total: 1, resolved: 0, unresolved: 1, currentPolicy: null, suggestedRule: "prefer_non_null" },
    { mappingId: "email", label: "Email", total: 1, resolved: 0, unresolved: 1, currentPolicy: null, suggestedRule: null },
  ] }, ...overrides };
}

function Harness({ initial = run(), onContinue = vi.fn() }: { initial?: RunSummary; onContinue?: () => void }) {
  const [value, setValue] = useState(initial);
  return <SurvivorshipWorkspace run={value} busy={false} onRun={setValue} onBusy={() => undefined} onError={() => undefined} onReview={() => undefined} onBack={() => undefined} onContinue={onContinue} />;
}

function previewResponse(runId = "run-1") {
  return { contractVersion: "1.0.0", runId, previewToken: "a".repeat(64), policyVersion: "survivorship-policy-v1-abc", configuredFields: 1, totalDifferences: 2, willHandle: 1, willRemain: 1, manualPreserved: 0, preservedBoth: 0, fields: [
    { semanticField: "phone", label: "Phone", differences: 1, willHandle: 1, willRemain: 0, manualPreserved: 0, alreadyHandled: 0, preservedBoth: 0 },
  ] };
}

afterEach(() => vi.unstubAllGlobals());

describe("merge plan workspace", () => {
  it("gates merge work while identity review remains", () => {
    render(<Harness initial={run({ reviewProgress: { total: 1, reviewed: 0, remaining: 1, deferred: 0 } })} />);
    expect(screen.getByRole("heading", { name: "Identity review isn't finished" })).toBeInTheDocument();
  });

  it("keeps field rules local, offers only the safe suggestion, and gates export", () => {
    render(<Harness />);
    expect(screen.getByRole("combobox", { name: "Rule for Phone" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Rule for Email" })).toBeInTheDocument();
    expect(screen.getAllByText("Use the value that exists").length).toBeGreaterThan(0);
    expect(screen.getByText(/1 \/ 1 handled, 0 remain if applied/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Prefer Dataset A when available" })).not.toBeInTheDocument();
    expect(screen.getByText(/Apply merge rules first/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue to Export" })).not.toBeInTheDocument();
  });

  it("previews multiple fields without mutation and applies only after explicit action", async () => {
    const preview = { contractVersion: "1.0.0", runId: "run-1", previewToken: "a".repeat(64), policyVersion: "survivorship-policy-v1-abc", configuredFields: 2, totalDifferences: 2, willHandle: 2, willRemain: 0, manualPreserved: 0, preservedBoth: 1, fields: [
      { semanticField: "phone", label: "Phone", differences: 1, willHandle: 1, willRemain: 0, manualPreserved: 0, alreadyHandled: 0, preservedBoth: 0 },
      { semanticField: "email", label: "Email", differences: 1, willHandle: 1, willRemain: 0, manualPreserved: 0, alreadyHandled: 0, preservedBoth: 1 },
    ] };
    const fetchMock = vi.fn((input: string | URL | Request) => Promise.resolve(new Response(JSON.stringify(String(input).endsWith("preview") ? preview : { run: run({ conflictSummary: { total: 2, resolved: 2, unresolved: 0, rulesApplied: true } }), appliedCount: 2 }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);
    fireEvent.change(screen.getByRole("combobox", { name: "Rule for Phone" }), { target: { value: "prefer_non_null" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Rule for Email" }), { target: { value: "keep_both" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview merge plan" }));
    expect(await screen.findByRole("heading", { name: "Merge plan preview" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Continue to Export" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply merge plan" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Continue to Export" })).toBeInTheDocument();
    expect(screen.getByText("All merge differences have an explicit outcome.")).toBeInTheDocument();
  });

  it("does not resurrect an obsolete preview that completes after a rule edit", async () => {
    let resolveResponse!: (response: Response) => void;
    const request = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(request));
    render(<Harness />);

    const phoneRule = screen.getByRole("combobox", { name: "Rule for Phone" });
    fireEvent.change(phoneRule, { target: { value: "prefer_non_null" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview merge plan" }));
    fireEvent.change(phoneRule, { target: { value: "keep_both" } });
    await act(async () => { resolveResponse(new Response(JSON.stringify(previewResponse()), { status: 200 })); await request; });

    expect(screen.queryByRole("heading", { name: "Merge plan preview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply merge plan" })).not.toBeInTheDocument();
  });

  it("rejects a preview belonging to another reconciliation", async () => {
    const onError = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(previewResponse("run-other")), { status: 200 })));
    render(<SurvivorshipWorkspace run={run()} busy={false} onRun={vi.fn()} onBusy={vi.fn()} onError={onError} onReview={vi.fn()} onBack={vi.fn()} onContinue={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Rule for Phone" }), { target: { value: "prefer_non_null" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview merge plan" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Merge preview did not match the active reconciliation."));
    expect(screen.queryByRole("heading", { name: "Merge plan preview" })).not.toBeInTheDocument();
  });

  it("locks rule selectors while a merge-plan request is pending", async () => {
    const request = new Promise<Response>(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(request));
    function BusyHarness() {
      const [busy, setBusy] = useState(false);
      return <SurvivorshipWorkspace run={run()} busy={busy} onRun={vi.fn()} onBusy={setBusy} onError={vi.fn()} onReview={vi.fn()} onBack={vi.fn()} onContinue={vi.fn()} />;
    }
    render(<BusyHarness />);
    fireEvent.change(screen.getByRole("combobox", { name: "Rule for Phone" }), { target: { value: "prefer_non_null" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview merge plan" }));
    expect(screen.getByRole("combobox", { name: "Rule for Phone" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Rule for Email" })).toBeDisabled();
  });

  it("does not replace the active run when an old merge-plan apply finishes late", async () => {
    let resolveApply!: (response: Response) => void;
    const pendingApply = new Promise<Response>((resolve) => { resolveApply = resolve; });
    const fetchMock = vi.fn((input: string | URL | Request) => String(input).endsWith("preview")
      ? Promise.resolve(new Response(JSON.stringify(previewResponse()), { status: 200 }))
      : pendingApply);
    vi.stubGlobal("fetch", fetchMock);
    const onRun = vi.fn();
    const props = { busy: false, onRun, onBusy: vi.fn(), onError: vi.fn(), onReview: vi.fn(), onBack: vi.fn(), onContinue: vi.fn() };
    const { rerender } = render(<SurvivorshipWorkspace run={run()} {...props} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Rule for Phone" }), { target: { value: "prefer_non_null" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview merge plan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply merge plan" }));
    rerender(<SurvivorshipWorkspace run={run({ runId: "run-2" })} {...props} />);

    await act(async () => {
      resolveApply(new Response(JSON.stringify({ run: run({ conflictSummary: { total: 2, resolved: 2, unresolved: 0, rulesApplied: true } }), appliedCount: 2 }), { status: 200 }));
      await pendingApply;
    });
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Merge plan preview" })).not.toBeInTheDocument();
  });

  it("does not reuse an earlier reconciliation's unsaved merge rules", () => {
    const props = { busy: false, onRun: vi.fn(), onBusy: vi.fn(), onError: vi.fn(), onReview: vi.fn(), onBack: vi.fn(), onContinue: vi.fn() };
    const { rerender } = render(<SurvivorshipWorkspace run={run()} {...props} />);
    const phoneRule = screen.getByRole("combobox", { name: "Rule for Phone" });
    fireEvent.change(phoneRule, { target: { value: "prefer_non_null" } });
    expect(phoneRule).toHaveValue("prefer_non_null");

    rerender(<SurvivorshipWorkspace run={run({ runId: "run-2" })} {...props} />);
    expect(screen.getByRole("combobox", { name: "Rule for Phone" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Preview merge plan" })).toBeDisabled();
  });

  it("rejects an apply response from another run without replacing the authoritative state", async () => {
    const onRun = vi.fn();
    const onError = vi.fn();
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => Promise.resolve(new Response(JSON.stringify(
      String(input).endsWith("preview") ? previewResponse() : { run: run({ runId: "run-other" }), appliedCount: 1 },
    ), { status: 200 }))));
    render(<SurvivorshipWorkspace run={run()} busy={false} onRun={onRun} onBusy={vi.fn()} onError={onError} onReview={vi.fn()} onBack={vi.fn()} onContinue={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Rule for Phone" }), { target: { value: "prefer_non_null" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview merge plan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply merge plan" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Merge plan response did not match the active reconciliation."));
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Apply merge plan" })).not.toBeInTheDocument();
  });
});
