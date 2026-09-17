import { describe, expect, it } from "vitest";

import type { CandidatePair } from "@samewise/contracts";
import { evidenceStateLabel } from "./review-model.js";

function candidate(evidenceClass: CandidatePair["evidence"][number]["evidenceClass"] = "missing_left"): CandidatePair {
  return {
    candidateId: "c1", aRowId: "A1", bRowId: "B1", aRecord: { name: "Acme" }, bRecord: { organization: "Acme Co" },
    rank: 1, matchScore: 0.4, runnerUpMargin: 0.01, band: "needs_review", collision: false, strongContradiction: false,
    blockingEvidence: [{ blockerId: "name", keyHash: "0123456789abcdef" }], positiveEvidence: 0, conflictEvidence: 0, totalWeight: 1,
    evidence: [{ mappingId: "name", label: "Name", aColumn: "name", bColumn: "organization", aValue: "", bValue: "Acme Co", normalizedA: "", normalizedB: "acme co", fieldKind: "name", featurePipelineVersion: "feature-pipeline-v0.1.0", features: [], outcome: "missing_one", evidenceClass, weight: 1, positiveContribution: 0, conflictContribution: 0, contribution: 0, explanationCode: "missing", explanation: "One mapped value is missing." }],
  };
}

describe("review model", () => {
  it("expresses missing and conflict evidence with deterministic non-color labels", () => {
    expect(evidenceStateLabel(candidate("missing_left"), "name")).toBe("Missing A");
    expect(evidenceStateLabel(candidate("missing_right"), "name")).toBe("Missing B");
    expect(evidenceStateLabel(candidate("missing_both"), "name")).toBe("Missing both");
    expect(evidenceStateLabel(candidate("conflict"), "name")).toBe("Conflict");
  });
});
