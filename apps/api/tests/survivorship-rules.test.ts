import { describe, expect, it } from "vitest";

import type { CandidatePair, FieldConflict, FieldPolicy, ManualMapping } from "@samewise/contracts";
import {
  buildSurvivorshipPolicy,
  isMissingForSurvivorship,
  manualResolution,
  previewRuleForConflict,
  resolutionFromPreview,
  SurvivorshipPolicyError,
} from "../src/survivorship.js";

const mappings: ManualMapping[] = [
  { mappingId: "name", label: "Name", aColumn: "name", bColumn: "name", useForMatching: true, includeInMerge: true, normalizer: "text" },
  { mappingId: "status", label: "Status", aColumn: "status", bColumn: "status", useForMatching: false, includeInMerge: true, normalizer: "text" },
  { mappingId: "updated", label: "Updated", aColumn: "updated", bColumn: "updated", useForMatching: false, includeInMerge: false, normalizer: "date" },
];

function conflict(aValue = "Active", bValue = "Inactive"): FieldConflict {
  return { conflictId: "conflict-1", runId: "run-1", candidateId: "candidate-1", mappingId: "status", label: "Status", aColumn: "status", bColumn: "status", aValue, bValue, identityDecisionId: "decision-1", identitySource: "human", status: "unresolved", resolution: null, resolutionHistory: [] };
}

function candidate(aTimestamp = "2026-01-02T00:00:00Z", bTimestamp = "2026-01-01T00:00:00Z"): CandidatePair {
  return {
    candidateId: "candidate-1", aRowId: "A1", bRowId: "B1", aRecord: { name: "Acme", status: "Active", updated: aTimestamp }, bRecord: { name: "Acme", status: "Inactive", updated: bTimestamp }, rank: 1, matchScore: 0.8, runnerUpMargin: 0.5, band: "needs_review", collision: false, strongContradiction: false, blockingEvidence: [{ blockerId: "name", keyHash: "0123456789abcdef" }], positiveEvidence: 1, conflictEvidence: 0, totalWeight: 1,
    evidence: [{ mappingId: "name", label: "Name", aColumn: "name", bColumn: "name", aValue: "Acme", bValue: "Acme", normalizedA: "acme", normalizedB: "acme", fieldKind: "name", featurePipelineVersion: "feature-pipeline-v0.2.0", features: [{ name: "exact", value: 1 }], outcome: "exact", evidenceClass: "exact_agreement", weight: 1, positiveContribution: 1, conflictContribution: 0, contribution: 1, explanationCode: "exact", explanation: "Exact." }],
  };
}

function rule(strategy: FieldPolicy["strategy"], extra: Partial<FieldPolicy> = {}): FieldPolicy {
  return { ruleId: "rule-1", semanticField: "status", strategy, ...extra };
}

describe("SW-008 deterministic survivorship rules", () => {
  it("implements USE A, USE B, and KEEP BOTH as explicit manual actions", () => {
    expect(manualResolution(conflict(), "use_a", "2026-01-01T00:00:00Z")).toMatchObject({ strategy: "use_a", resolutionSource: "manual", chosenSource: "A", chosenValue: "Active", policyVersion: null });
    expect(manualResolution(conflict(), "use_b", "2026-01-01T00:00:00Z")).toMatchObject({ strategy: "use_b", resolutionSource: "manual", chosenSource: "B", chosenValue: "Inactive" });
    expect(manualResolution(conflict(), "keep_both", "2026-01-01T00:00:00Z")).toMatchObject({ strategy: "keep_both", resolutionSource: "keep_both", chosenSource: null, chosenValue: null, keptValues: [{ source: "A", value: "Active" }, { source: "B", value: "Inactive" }] });
  });

  it("uses conservative missing semantics without mutating literals", () => {
    expect(isMissingForSurvivorship("")).toBe(true);
    expect(isMissingForSurvivorship(" \t ")).toBe(true);
    expect(isMissingForSurvivorship("NULL")).toBe(false);
    expect(isMissingForSurvivorship("N/A")).toBe(false);
  });

  it("prefers exactly one non-missing value and leaves ties unresolved", () => {
    expect(previewRuleForConflict(conflict("", "Active"), candidate(), rule("prefer_non_null"), mappings)).toMatchObject({ outcome: "would_resolve", chosenSource: "B", chosenValue: "Active" });
    expect(previewRuleForConflict(conflict("Active", "  "), candidate(), rule("prefer_non_null"), mappings)).toMatchObject({ outcome: "would_resolve", chosenSource: "A" });
    expect(previewRuleForConflict(conflict("Active", "Inactive"), candidate(), rule("prefer_non_null"), mappings)).toMatchObject({ outcome: "unresolved", reasonCode: "both_values_populated" });
    expect(previewRuleForConflict(conflict("", " "), candidate(), rule("prefer_non_null"), mappings)).toMatchObject({ outcome: "unresolved", reasonCode: "both_values_missing" });
  });

  it("uses an explicit per-field trusted source with no hidden fallback", () => {
    expect(previewRuleForConflict(conflict("Active", "Inactive"), candidate(), rule("prefer_trusted_source", { trustedSource: "B" }), mappings)).toMatchObject({ outcome: "would_resolve", chosenSource: "B", chosenValue: "Inactive", reasonCode: "trusted_source_b" });
    expect(previewRuleForConflict(conflict("Active", " "), candidate(), rule("prefer_trusted_source", { trustedSource: "B" }), mappings)).toMatchObject({ outcome: "unresolved", reasonCode: "trusted_source_missing" });
  });

  it.each([
    ["A newer", "2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z", "would_resolve", "A", "newest_a"],
    ["B newer", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "would_resolve", "B", "newest_b"],
    ["equal", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "unresolved", null, "timestamps_equal"],
    ["same instant offsets", "2026-01-01T01:00:00+01:00", "2026-01-01T00:00:00Z", "unresolved", null, "timestamps_equal"],
    ["A missing", "", "2026-01-01", "unresolved", null, "timestamp_missing"],
    ["B missing", "2026-01-01", "", "unresolved", null, "timestamp_missing"],
    ["both missing", "", " ", "unresolved", null, "both_timestamps_missing"],
    ["malformed", "yesterday", "2026-01-01", "unresolved", null, "timestamp_unparseable"],
    ["invalid calendar date", "2026-02-30", "2026-01-01", "unresolved", null, "timestamp_unparseable"],
  ])("prefer newest: %s", (_name, aTimestamp, bTimestamp, outcome, chosenSource, reasonCode) => {
    expect(previewRuleForConflict(conflict(), candidate(aTimestamp!, bTimestamp!), rule("prefer_newest", { timestampMappingId: "updated" }), mappings)).toMatchObject({ outcome, chosenSource, reasonCode });
  });

  it("retains policy version, raw inputs, timestamps, source, and reason in rule provenance", () => {
    const currentConflict = conflict();
    const preview = previewRuleForConflict(currentConflict, candidate(), rule("prefer_newest", { timestampMappingId: "updated" }), mappings);
    expect(resolutionFromPreview(preview, currentConflict, rule("prefer_newest", { timestampMappingId: "updated" }), "policy-v1", "2026-01-03T00:00:00Z")).toMatchObject({ resolutionSource: "rule", policyVersion: "policy-v1", ruleId: "rule-1", inputSnapshot: { aValue: "Active", bValue: "Inactive", aTimestamp: "2026-01-02T00:00:00Z", bTimestamp: "2026-01-01T00:00:00Z" } });
  });

  it("validates policy fields and options atomically with a deterministic content version", () => {
    const input = { fieldPolicies: [{ semanticField: "status", strategy: "prefer_trusted_source" as const, trustedSource: "A" as const }] };
    const first = buildSurvivorshipPolicy(input, mappings, "2026-01-01T00:00:00Z");
    const second = buildSurvivorshipPolicy(input, mappings, "2026-02-01T00:00:00Z");
    expect(first.policyVersion).toBe(second.policyVersion);
    expect(() => buildSurvivorshipPolicy({ fieldPolicies: [{ semanticField: "unknown", strategy: "prefer_non_null" }] }, mappings)).toThrow(SurvivorshipPolicyError);
    expect(() => buildSurvivorshipPolicy({ fieldPolicies: [{ semanticField: "status", strategy: "prefer_newest", timestampMappingId: "name" }] }, mappings)).toThrow("valid mapped date field");
    expect(() => buildSurvivorshipPolicy({ fieldPolicies: [{ semanticField: "status", strategy: "prefer_non_null", trustedSource: "A" }] }, mappings)).toThrow("does not accept");
  });

  it("skips manual and existing rule resolutions and produces the same deterministic preview repeatedly", () => {
    const current = conflict("", "Active");
    const selected = manualResolution(current, "use_a");
    current.resolution = selected; current.status = "resolved";
    expect(previewRuleForConflict(current, candidate(), rule("prefer_non_null"), mappings).outcome).toBe("skipped_manual");
    current.resolution = { ...selected, resolutionSource: "rule", policyVersion: "old", ruleId: "old" };
    expect(previewRuleForConflict(current, candidate(), rule("prefer_non_null"), mappings).outcome).toBe("skipped_existing");
    current.resolution = null; current.status = "unresolved";
    expect(previewRuleForConflict(current, candidate(), rule("prefer_non_null"), mappings)).toEqual(previewRuleForConflict(current, candidate(), rule("prefer_non_null"), mappings));
  });

  it("processes thousands of independent conflicts without cross-field state", () => {
    const started = performance.now();
    const outcomes = Array.from({ length: 5_000 }, (_, index) => previewRuleForConflict({ ...conflict("", `${index}`), conflictId: `conflict-${index}` }, candidate(), rule("prefer_non_null"), mappings));
    expect(outcomes).toHaveLength(5_000);
    expect(outcomes.every((item) => item.outcome === "would_resolve" && item.chosenSource === "B")).toBe(true);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
