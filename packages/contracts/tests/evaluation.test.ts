import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { EvaluationCatalogSchema, HumanReviewEvidenceSchema } from "../src/index.js";

describe("SW-009 evaluation contracts", () => {
  it("validates the committed immutable snapshot catalog", async () => {
    const path = new URL("../../../evaluation/reports/sw-009/catalog.json", import.meta.url);
    const catalog = EvaluationCatalogSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(catalog.snapshots).toHaveLength(2);
    expect(catalog.comparisons[0]?.compatible).toBe(true);
  });

  it("requires the reviewed-subset sampling caveat", () => {
    expect(HumanReviewEvidenceSchema.safeParse({
      source: { type: "HUMAN_REVIEW_LABELS", representative: false, caveat: "Accuracy" },
      labeledCandidateCount: 0, sameLabels: 0, differentLabels: 0,
      systemProposalEligibleCount: 0, systemProposalAgreementCount: 0,
      systemProposalAgreementRate: null, autoProposedSameRejected: 0,
      topCandidateLabels: 0, alternateCandidateLabels: 0,
      matcherVersions: [], candidateEngineVersions: [], labels: [],
    }).success).toBe(false);
  });
});
