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

function renderWorkspace(catalogOverride = catalog) {
  return render(<EvaluationWorkspace runId="run-1" initialCatalog={catalogOverride} initialHumanEvidence={human} initialErrorPage={candidatePage} onBack={() => undefined} />);
}

describe("SW-009 evaluation workspace", () => {
  it("opens on Overview with the four primary metrics and compact quality evidence", () => {
    renderWorkspace();
    expect(screen.getByRole("heading", { name: "Evaluation" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("organizations-matcher-holdout-1200-v1")).toBeInTheDocument();
    expect(screen.getByText("All quality gates pass")).toBeInTheDocument();
    for (const name of ["Candidate recall", "Auto-match precision", "End-to-end true-link recovery", "Review rate"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("866 / 879")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pair-level pipeline" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Version comparison" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Threshold analysis" })).not.toBeInTheDocument();
    expect(screen.queryByText(/overall accuracy/i)).not.toBeInTheDocument();
  });

  it("keeps benchmark metadata, secondary metrics, and gate rows in accessible disclosures", () => {
    renderWorkspace();
    const benchmarkSummary = screen.getByText("Benchmark details");
    const benchmarkDetails = benchmarkSummary.closest("details")!;
    expect(benchmarkDetails).not.toHaveAttribute("open");
    fireEvent.click(benchmarkSummary);
    expect(benchmarkDetails).toHaveAttribute("open");
    expect(within(benchmarkDetails).getByText("candidate-engine-v0.2.0")).toBeInTheDocument();

    const metricsSummary = screen.getByText("More metrics");
    expect(metricsSummary.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(metricsSummary);
    expect(screen.getByText("Top-1 true-candidate rate")).toBeInTheDocument();

    const gatesSummary = screen.getByText("View gate details");
    const gateDetails = gatesSummary.closest("details")!;
    expect(gateDetails).not.toHaveAttribute("open");
    fireEvent.click(gatesSummary);
    expect(gateDetails).toHaveAttribute("open");
    expect(within(gateDetails).getAllByText("PASS").length).toBeGreaterThan(0);
  });

  it("moves comparison evidence into Compare and supports arrow-key tab navigation", () => {
    renderWorkspace();
    const overviewTab = screen.getByRole("tab", { name: "Overview" });
    fireEvent.keyDown(overviewTab, { key: "ArrowRight" });
    const compareTab = screen.getByRole("tab", { name: "Compare" });
    expect(compareTab).toHaveFocus();
    expect(compareTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Version comparison" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "SW-005F weak-identifier falsification" })).toBeInTheDocument();
    expect(screen.getByText("baseline-matcher-v0.1.0")).toBeInTheDocument();
  });

  it("moves score evidence and the unchanged what-if control into Thresholds", () => {
    renderWorkspace();
    expect(screen.queryByLabelText("Auto-match threshold")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Thresholds" }));
    expect(screen.getByRole("heading", { name: "Threshold analysis" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Empirical score bands" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Auto-match threshold"), { target: { value: "0.55" } });
    expect(screen.getByText("113").closest("span")).toHaveTextContent("auto matches");
    expect(screen.getByText(/cannot change production matcher configuration/i)).toBeInTheDocument();
    expect(screen.getByText(/not calibrated probabilities/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /deploy|apply threshold/i })).not.toBeInTheDocument();
  });

  it("shows one compact error at a time and discloses full records on demand", () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "Errors" }));
    expect(screen.getByRole("heading", { name: "Failure evidence" })).toBeInTheDocument();
    expect(screen.getAllByText(/Evaluation-only truth · SAME/)).toHaveLength(1);
    const inspectSummary = screen.getByText("Inspect records");
    const recordDetails = inspectSummary.closest("details")!;
    expect(recordDetails).not.toHaveAttribute("open");
    fireEvent.click(inspectSummary);
    expect(recordDetails).toHaveAttribute("open");
    expect(within(recordDetails).getByRole("heading", { name: "Visible A record" })).toBeInTheDocument();
    expect(within(recordDetails).getByRole("heading", { name: "Visible B record" })).toBeInTheDocument();
  });

  it("preserves error taxonomy navigation and API paging", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(falseUnmatchedPage), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(hardNegativePage), { status: 200 }));
    render(<EvaluationWorkspace runId={null} initialCatalog={catalog} initialHumanEvidence={human} initialErrorPage={candidatePage} onBack={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Errors" }));
    fireEvent.click(screen.getByRole("tab", { name: /False unmatched/ }));
    expect(await screen.findByText(/Showing 14 of 14/)).toBeInTheDocument();
    expect(screen.getAllByText(/Evaluation-only truth · SAME/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: /Hard negatives/ }));
    expect(await screen.findByText(/Showing 6 of 6/)).toBeInTheDocument();
    expect(screen.getAllByText(/Evaluation-only truth · DIFFERENT/)).toHaveLength(1);
    expect(screen.getByText("No").closest("dd")).toHaveTextContent("No");
    vi.restoreAllMocks();
  });

  it("keeps the non-representative human-label caveat in its own view", () => {
    renderWorkspace();
    expect(screen.queryByText("Reviewed subset · not representative")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Human labels" }));
    expect(screen.getByRole("heading", { name: "Human labels" })).toBeInTheDocument();
    expect(screen.getByText("Reviewed subset · not representative")).toBeInTheDocument();
    expect(screen.getByText("These labels come from cases selected for review and may not represent the full dataset distribution.")).toBeInTheDocument();
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
    renderWorkspace(incompatible);
    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    expect(screen.getByText("Not directly comparable.")).toBeInTheDocument();
    expect(screen.getByText("Different fixture or label-set identity.")).toBeInTheDocument();
  });
});
