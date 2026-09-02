import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunView } from "@samewise/contracts";
import { SurvivorshipWorkspace } from "./SurvivorshipWorkspace.js";

const evidence = { mappingId: "name", label: "Name", aColumn: "name", bColumn: "name", aValue: "Acme", bValue: "Acme", normalizedA: "acme", normalizedB: "acme", fieldKind: "name" as const, featurePipelineVersion: "feature-pipeline-v0.1.0" as const, features: [{ name: "exact", value: 1 }], outcome: "exact" as const, evidenceClass: "exact_agreement" as const, weight: 1, positiveContribution: 1, conflictContribution: 0, contribution: 1, explanationCode: "exact", explanation: "Exact." };

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    contractVersion: "1.0.0", runId: "run-1", stage: "resolution", datasets: {},
    mappings: [
      { mappingId: "name", label: "Name", aColumn: "name", bColumn: "name", role: "identity", normalizer: "text" },
      { mappingId: "phone", label: "Phone", aColumn: "phone", bColumn: "phone", role: "comparison", normalizer: "phone" },
      { mappingId: "updated", label: "Updated", aColumn: "updated", bColumn: "updated", role: "comparison", normalizer: "date" },
    ], mappingVersion: "confirmed-mappings-v1", semanticMappingProvenance: null, matcherVersion: "explainable-matcher-v0.2.0",
    matcherProvenance: { matcherVersion: "explainable-matcher-v0.2.0", candidateEngineVersion: "candidate-engine-v0.2.0", blockingNormalizationVersion: "blocking-normalization-v0.1.0", featurePipelineVersion: "feature-pipeline-v0.1.0", matcherConfigVersion: "matcher-config-v0.2.0", matcherConfig: {} },
    summary: { matched: 1, needsReview: 0, onlyA: 0, onlyB: 0 },
    candidates: [{ candidateId: "candidate-1", aRowId: "A1", bRowId: "B1", aRecord: { name: "Acme", phone: "", updated: "2026-01-01" }, bRecord: { name: "Acme", phone: "+1 216", updated: "2026-01-01" }, rank: 1, matchScore: 1, runnerUpMargin: 1, band: "needs_review", collision: false, strongContradiction: false, blockingEvidence: [{ blockerId: "name", keyHash: "0123456789abcdef" }], positiveEvidence: 1, conflictEvidence: 0, totalWeight: 1, evidence: [evidence] }],
    decisions: [{ decisionId: "decision-1", runId: "run-1", candidateId: "candidate-1", aRowId: "A1", bRowId: "B1", systemProposal: "needs_review", humanDecision: "same_entity", matcherVersion: "explainable-matcher-v0.2.0", candidateEngineVersion: "candidate-engine-v0.2.0", matchScore: 0.72, evidenceShown: [evidence], decidedAt: "2026-01-01T00:00:00Z" }],
    conflicts: [{ conflictId: "conflict-phone", runId: "run-1", candidateId: "candidate-1", mappingId: "phone", label: "Phone", aColumn: "phone", bColumn: "phone", aValue: "", bValue: "+1 216", identityDecisionId: "decision-1", identitySource: "human", status: "unresolved", resolution: null, resolutionHistory: [] }],
    survivorshipPolicy: null, trustedExportReadiness: { ready: false, unresolvedIdentityCount: 0, unresolvedConflictCount: 1, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: ["1 comparison-field conflict(s) remain unresolved."] },
    reviewQueue: [], reviewProgress: { total: 0, reviewed: 0, remaining: 0, deferred: 0 }, reviewUndo: null, onlyA: [], onlyB: [], ...overrides,
  };
}

function Harness({ initial = run() }: { initial?: RunView }) {
  const [value, setValue] = useState(initial);
  return <SurvivorshipWorkspace run={value} busy={false} onRun={setValue} onBusy={() => undefined} onError={() => undefined} onBack={() => undefined} onContinue={() => undefined} />;
}

afterEach(() => vi.unstubAllGlobals());

describe("SW-008 survivorship workspace", () => {
  it("keeps identity controls separate and exposes counts, manual choices, provenance, and clear", async () => {
    const resolution = { resolutionId: "r1", strategy: "use_b" as const, resolutionSource: "manual" as const, chosenSource: "B" as const, chosenValue: "+1 216", keptValues: [], reasonCode: "use_b", reason: "A user explicitly selected Dataset B.", policyVersion: null, ruleId: null, inputSnapshot: { aValue: "", bValue: "+1 216", aTimestamp: null, bTimestamp: null }, resolvedAt: "2026-01-01T01:00:00Z" };
    const resolved = run({ conflicts: [{ ...run().conflicts[0]!, status: "resolved", resolution }], trustedExportReadiness: { ready: true, unresolvedIdentityCount: 0, unresolvedConflictCount: 0, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: [] } });
    const cleared = run({ conflicts: [{ ...run().conflicts[0]!, resolutionHistory: [resolution] }] });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(resolved), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(cleared), { status: 200, headers: { "Content-Type": "application/json" } })));
    render(<Harness />);
    expect(screen.getByRole("heading", { name: "Identity is settled. Values are not." })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Same entity" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Conflict status")).toHaveTextContent("Unresolved1Resolved0");
    fireEvent.click(screen.getByRole("button", { name: "Use B" }));
    expect(await screen.findByText(/manual · use b/i)).toBeInTheDocument();
    expect(screen.getByText("Why this value won").parentElement).toHaveTextContent("explicitly selected Dataset B");
    fireEvent.click(screen.getByRole("button", { name: "Clear resolution" }));
    await waitFor(() => expect(screen.getByText("Unresolved")).toBeInTheDocument());
  });

  it("requires policy save, preview, and explicit apply while preserving a rule badge", async () => {
    const policy = { contractVersion: "1.0.0" as const, schemaVersion: "survivorship-policy-v1" as const, policyVersion: "survivorship-policy-v1-test", configuredAt: "2026-01-01T00:00:00Z", fieldPolicies: [{ ruleId: "rule-1-phone", semanticField: "phone", strategy: "prefer_non_null" as const }] };
    const configured = run({ survivorshipPolicy: policy });
    const preview = { contractVersion: "1.0.0", runId: "run-1", policyVersion: policy.policyVersion, ruleId: "rule-1-phone", semanticField: "phone", strategy: "prefer_non_null", affectedCount: 1, resolvableCount: 1, unresolvedCount: 0, skippedManualCount: 0, items: [{ conflictId: "conflict-phone", candidateId: "candidate-1", semanticField: "phone", outcome: "would_resolve", chosenSource: "B", chosenValue: "+1 216", keptValues: [], aTimestamp: null, bTimestamp: null, reasonCode: "non_null_b", reason: "Would choose Dataset B because it is the only source with a non-missing value." }] };
    const resolution = { resolutionId: "r-rule", strategy: "prefer_non_null" as const, resolutionSource: "rule" as const, chosenSource: "B" as const, chosenValue: "+1 216", keptValues: [], reasonCode: "non_null_b", reason: "choose Dataset B because it is the only source with a non-missing value.", policyVersion: policy.policyVersion, ruleId: "rule-1-phone", inputSnapshot: { aValue: "", bValue: "+1 216", aTimestamp: null, bTimestamp: null }, resolvedAt: "2026-01-01T01:00:00Z" };
    const applied = run({ survivorshipPolicy: policy, conflicts: [{ ...run().conflicts[0]!, status: "resolved", resolution }], trustedExportReadiness: { ready: true, unresolvedIdentityCount: 0, unresolvedConflictCount: 0, eligibleConfirmedCount: 1, onlyACount: 0, onlyBCount: 0, blockers: [] } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(configured), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ run: applied, appliedCount: 1, unresolvedCount: 0, skippedCount: 0 }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Apply previewed rule" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save policy" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview rule" })).toBeEnabled());
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PUT" });
    fireEvent.click(screen.getByRole("button", { name: "Preview rule" }));
    expect(await screen.findByText(/Preview: 1 resolvable/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply previewed rule" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Apply previewed rule" }));
    expect(await screen.findByText(/rule · prefer non null/i)).toBeInTheDocument();
  });

  it("announces an unresolvable prefer-newest preview without inventing a winner", async () => {
    const policy = { contractVersion: "1.0.0" as const, schemaVersion: "survivorship-policy-v1" as const, policyVersion: "policy-newest", configuredAt: "2026-01-01T00:00:00Z", fieldPolicies: [{ ruleId: "rule-newest", semanticField: "phone", strategy: "prefer_newest" as const, timestampMappingId: "updated" }] };
    const initial = run({ survivorshipPolicy: policy });
    const preview = { contractVersion: "1.0.0", runId: "run-1", policyVersion: "policy-newest", ruleId: "rule-newest", semanticField: "phone", strategy: "prefer_newest", affectedCount: 1, resolvableCount: 0, unresolvedCount: 1, skippedManualCount: 0, items: [{ conflictId: "conflict-phone", candidateId: "candidate-1", semanticField: "phone", outcome: "unresolved", chosenSource: null, chosenValue: null, keptValues: [], aTimestamp: "2026-01-01", bTimestamp: "2026-01-01", reasonCode: "timestamps_equal", reason: "Cannot resolve because the configured timestamps represent the same instant." }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(preview), { status: 200, headers: { "Content-Type": "application/json" } })));
    render(<Harness initial={initial} />);
    fireEvent.change(screen.getByLabelText("Rule"), { target: { value: "prefer_newest" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview rule" }));
    expect(await screen.findByText(/Cannot resolve because the configured timestamps represent the same instant/)).toBeInTheDocument();
    expect(screen.getByText(/Preview: 0 resolvable · 1 unresolved/)).toBeInTheDocument();
  });
});
