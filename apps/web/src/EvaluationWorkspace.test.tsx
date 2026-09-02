import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  EvaluationCatalogSchema,
  EvaluationErrorPageSchema,
  HumanReviewEvidenceSchema,
} from "@samewise/contracts";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { EvaluationWorkspace } from "./EvaluationWorkspace.js";

let catalog: ReturnType<typeof EvaluationCatalogSchema.parse>;
let candidatePage: ReturnType<typeof EvaluationErrorPageSchema.parse>;
let falseUnmatchedPage: ReturnType<typeof EvaluationErrorPageSchema.parse>;
let hardNegativePage: ReturnType<typeof EvaluationErrorPageSchema.parse>;

beforeAll(async () => {
  const root = join(process.cwd(), "..", "..", "evaluation", "reports", "sw-009");
  catalog = EvaluationCatalogSchema.parse(JSON.parse(await readFile(join(root, "catalog.json"), "utf8")));
  const current = catalog.snapshots.find((snapshot) => snapshot.provenance.matcherVersion === "explainable-matcher-v0.2.0")!;
  const errors = JSON.parse(await readFile(join(root, current.id, "errors.json"), "utf8")) as unknown[];
  const page = (group: "candidate_misses" | "false_unmatched" | "hard_negatives") => EvaluationErrorPageSchema.parse({
    snapshotId: current.id, group, offset: 0, limit: 20,
    total: errors.filter((error) => typeof error === "object" && error !== null && "group" in error && error.group === group).length,
    items: errors.filter((error) => typeof error === "object" && error !== null && "group" in error && error.group === group).slice(0, 20),
  });
  candidatePage = page("candidate_misses");
  falseUnmatchedPage = page("false_unmatched");
  hardNegativePage = page("hard_negatives");
});

const human = HumanReviewEvidenceSchema.parse({
  source: { type: "HUMAN_REVIEW_LABELS", representative: false, caveat: "These labels come from cases selected for review and may not represent the full dataset distribution." },
  labeledCandidateCount: 2, sameLabels: 1, differentLabels: 1,
  systemProposalEligibleCount: 0, systemProposalAgreementCount: 0,
  systemProposalAgreementRate: null, autoProposedSameRejected: 0,
  topCandidateLabels: 1, alternateCandidateLabels: 1,
  matcherVersions: ["explainable-matcher-v0.2.0"], candidateEngineVersions: ["candidate-engine-v0.2.0"], labels: [],
});

describe("SW-009 evaluation workspace", () => {
  it("renders identity, denominator-labeled metrics, pipeline, comparison, score bands, and reviewed-subset caveat", () => {
    render(<EvaluationWorkspace runId="run-1" initialCatalog={catalog} initialHumanEvidence={human} initialErrorPage={candidatePage} onBack={() => undefined} />);
    expect(screen.getByRole("heading", { name: "What changed between matcher versions?" })).toBeInTheDocument();
    expect(screen.getByText("organizations-matcher-holdout-1200-v1")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "SW-005F weak-identifier falsification" })).toBeInTheDocument();
    const candidateRecall = screen.getByRole("heading", { name: "Candidate recall" }).closest("article")!;
    expect(within(candidateRecall).getByText("866 / 879")).toBeInTheDocument();
    const reviewRate = screen.getByRole("heading", { name: "Review rate" }).closest("article")!;
    expect(within(reviewRate).getByText("598 / 858")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Where true links were lost" })).toBeInTheDocument();
    expect(screen.getByText("All current gates passed")).toBeInTheDocument();
    expect(screen.getByText("baseline-matcher-v0.1.0")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Empirical score bands" })).toBeInTheDocument();
    expect(screen.queryByText(/probability/i)).not.toBeInTheDocument();
    expect(screen.getByText("Reviewed subset · not representative")).toBeInTheDocument();
    expect(screen.queryByText(/overall accuracy/i)).not.toBeInTheDocument();
  });

  it("marks candidate-miss truth as evaluation-only and pages error groups", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(falseUnmatchedPage), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(hardNegativePage), { status: 200 }));
    render(<EvaluationWorkspace runId={null} initialCatalog={catalog} initialHumanEvidence={human} initialErrorPage={candidatePage} onBack={() => undefined} />);
    expect(screen.getAllByText(/Evaluation-only truth · SAME/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: /False unmatched/ }));
    expect(await screen.findAllByText(/Evaluation-only truth · SAME/)).toHaveLength(14);
    fireEvent.click(screen.getByRole("tab", { name: /Hard negatives/ }));
    expect(await screen.findAllByText(/Evaluation-only truth · DIFFERENT/)).toHaveLength(6);
    expect(screen.getAllByText(/auto-matched: no/).length).toBeGreaterThan(0);
    vi.restoreAllMocks();
  });

  it("changes threshold analysis without exposing a deployment action", () => {
    render(<EvaluationWorkspace runId={null} initialCatalog={catalog} initialHumanEvidence={human} initialErrorPage={candidatePage} onBack={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Auto-match threshold"), { target: { value: "0.55" } });
    expect(screen.getByText("113").closest("span")).toHaveTextContent("auto matches");
    expect(screen.getByText(/cannot change production matcher configuration/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /deploy|apply threshold/i })).not.toBeInTheDocument();
  });

  it("surfaces incompatible comparison state without deltas", () => {
    const incompatible = EvaluationCatalogSchema.parse({
      ...catalog,
      comparisons: [{
        ...catalog.comparisons[0]!, compatible: false,
        status: "Not directly comparable.", reasons: ["Different fixture or label-set identity."],
        metrics: catalog.comparisons[0]!.metrics.map((row) => ({ ...row, delta: null })),
      }],
    });
    render(<EvaluationWorkspace runId={null} initialCatalog={incompatible} initialHumanEvidence={human} initialErrorPage={candidatePage} onBack={() => undefined} />);
    expect(screen.getByText("Not directly comparable.")).toBeInTheDocument();
    expect(screen.getByText("Different fixture or label-set identity.")).toBeInTheDocument();
  });
});
