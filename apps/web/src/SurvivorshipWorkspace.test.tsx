import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConflictProjectionItem, RunSummary } from "@samewise/contracts";
import { SurvivorshipWorkspace } from "./SurvivorshipWorkspace.js";

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return { contractVersion: "1.0.0", projectionVersion: "1.0.0", runId: "run-1", stage: "resolution", datasets: {}, mappings: [{ mappingId: "name", label: "Name", aColumn: "name", bColumn: "name", role: "identity", normalizer: "text" }, { mappingId: "phone", label: "Phone", aColumn: "phone", bColumn: "phone", role: "comparison", normalizer: "phone" }, { mappingId: "updated", label: "Updated", aColumn: "updated", bColumn: "updated", role: "comparison", normalizer: "date" }], mappingVersion: "confirmed-mappings-v1", semanticMappingProvenance: null, matcherVersion: "explainable-matcher-v0.2.0", matcherProvenance: { matcherVersion: "explainable-matcher-v0.2.0", candidateEngineVersion: "candidate-engine-v0.3.0", blockingNormalizationVersion: "blocking-normalization-v0.1.0", featurePipelineVersion: "feature-pipeline-v0.1.0", matcherConfigVersion: "matcher-config-v0.2.0", matcherConfig: {} }, summary: { matched: 1, needsReview: 0, onlyA: 0, onlyB: 0 }, survivorshipPolicy: null, trustedExportReadiness: { ready: false, unresolvedIdentityCount: 0, unresolvedConflictCount: 1, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: ["conflict"] }, reviewProgress: { total: 0, reviewed: 0, remaining: 0, deferred: 0 }, reviewUndo: null, conflictSummary: { total: 1, resolved: 0, unresolved: 1 }, ...overrides };
}

const conflict = { conflictId: "conflict-phone", runId: "run-1", candidateId: "candidate-1", mappingId: "phone", label: "Phone", aColumn: "phone", bColumn: "phone", aValue: "", bValue: "+1 216", identityDecisionId: "decision-1", identitySource: "human" as const, status: "unresolved" as const, resolution: null, resolutionHistory: [], aRowId: "A1", bRowId: "B1" };
const page = (item: ConflictProjectionItem = conflict) => ({ contractVersion: "1.0.0", runId: "run-1", items: [item], page: { offset: 0, limit: 50, total: 1, returned: 1, nextOffset: null, previousOffset: null }, ordering: "conflict_id_ascending" });

function Harness({ initial = run() }: { initial?: RunSummary }) {
  const [value, setValue] = useState(initial);
  return <SurvivorshipWorkspace run={value} busy={false} onRun={setValue} onBusy={() => undefined} onError={() => undefined} onBack={() => undefined} onContinue={() => undefined} />;
}

afterEach(() => vi.unstubAllGlobals());

describe("bounded survivorship workspace", () => {
  it("loads a bounded conflict page and keeps manual resolution separate from identity", async () => {
    const resolution = { resolutionId: "r1", strategy: "use_b" as const, resolutionSource: "manual" as const, chosenSource: "B" as const, chosenValue: "+1 216", keptValues: [], reasonCode: "use_b", reason: "A user explicitly selected Dataset B.", policyVersion: null, ruleId: null, inputSnapshot: { aValue: "", bValue: "+1 216", aTimestamp: null, bTimestamp: null }, resolvedAt: "2026-01-01T01:00:00Z" };
    let resolved = false;
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/conflicts?") ) return Promise.resolve(new Response(JSON.stringify(page(resolved ? { ...conflict, status: "resolved", resolution } : conflict)), { status: 200 }));
      if (init?.method === "POST") { resolved = true; return Promise.resolve(new Response(JSON.stringify(run({ conflictSummary: { total: 1, resolved: 1, unresolved: 0 } })), { status: 200 })); }
      return Promise.resolve(new Response("{}", { status: 404 }));
    }));
    render(<Harness />);
    expect(await screen.findByRole("heading", { name: "Phone" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Same entity" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use B" }));
    expect(await screen.findByText(/manual · use b/i)).toBeInTheDocument();
    expect(screen.getByText("Why this value won").parentElement).toHaveTextContent("explicitly selected Dataset B");
  });

  it("requires save, preview, and explicit apply without applying on save", async () => {
    const policy = { contractVersion: "1.0.0" as const, schemaVersion: "survivorship-policy-v1" as const, policyVersion: "policy-1", configuredAt: "2026-01-01T00:00:00Z", fieldPolicies: [{ ruleId: "rule-1-phone", semanticField: "phone", strategy: "prefer_non_null" as const }] };
    const configured = run({ survivorshipPolicy: policy });
    const preview = { contractVersion: "1.0.0", runId: "run-1", policyVersion: policy.policyVersion, ruleId: "rule-1-phone", semanticField: "phone", strategy: "prefer_non_null", affectedCount: 1, resolvableCount: 1, unresolvedCount: 0, skippedManualCount: 0, items: [{ conflictId: "conflict-phone", candidateId: "candidate-1", semanticField: "phone", outcome: "would_resolve", chosenSource: "B", chosenValue: "+1 216", keptValues: [], aTimestamp: null, bTimestamp: null, reasonCode: "non_null_b", reason: "Would choose Dataset B." }] };
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/conflicts?")) return Promise.resolve(new Response(JSON.stringify(page()), { status: 200 }));
      if (url.endsWith("survivorship-policy") && init?.method === "PUT") return Promise.resolve(new Response(JSON.stringify(configured), { status: 200 }));
      if (url.endsWith("survivorship-preview")) return Promise.resolve(new Response(JSON.stringify(preview), { status: 200 }));
      if (url.endsWith("survivorship-apply")) return Promise.resolve(new Response(JSON.stringify({ run: run({ survivorshipPolicy: policy }), appliedCount: 1, unresolvedCount: 0, skippedCount: 0 }), { status: 200 }));
      return Promise.resolve(new Response("{}", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Apply previewed rule" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview rule" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Preview rule" }));
    expect(await screen.findByText(/Preview: 1 resolvable/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply previewed rule" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("survivorship-apply"))).toBe(true));
  });
});
