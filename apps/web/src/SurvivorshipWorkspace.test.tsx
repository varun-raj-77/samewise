import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
});
