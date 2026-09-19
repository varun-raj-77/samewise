import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ReviewQueueProjectionItem } from "@samewise/contracts";
import { VirtualReviewQueue } from "./VirtualReviewQueue.js";

function item(index: number): ReviewQueueProjectionItem {
  const candidateId = `candidate-${index}`;
  const bRowId = `B${index.toString().padStart(5, "0")}`;
  return {
    aRowId: `A${index.toString().padStart(5, "0")}`,
    topCandidateId: candidateId, topBRowId: bRowId,
    topMatchScore: 0.5, runnerUpMargin: 0.02, candidateCount: 1,
    strongestPositive: null, strongestContradiction: null, collision: false, collisionARowIds: [], strongContradiction: false,
    state: "needs_review", deferred: false, humanDecision: null,
    matcherVersion: "explainable-matcher-v0.3.0", sourceOrder: index,
    aIdentity: { name: `A ${index}` }, topBIdentity: { name: `B ${index}` },
    candidates: [{ candidateId, bRowId, rank: 1, matchScore: 0.5, band: "needs_review", collision: false, strongContradiction: false, strongestPositive: null, strongestContradiction: null, humanDecision: null }],
  };
}

describe("virtual review queue", () => {
  it("bounds mounted rows for a deterministic 10,000-item queue", () => {
    const items = Array.from({ length: 10_000 }, (_, index) => item(index));
    const onSelect = vi.fn();
    render(<VirtualReviewQueue items={items} selectedARowId={null} onSelect={onSelect} />);
    const mounted = screen.getAllByTestId("review-queue-row");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(30);
    expect(screen.getByTestId("review-queue-viewport").firstElementChild).toHaveStyle({ height: `${10_000 * 94}px` });
    fireEvent.scroll(screen.getByTestId("review-queue-viewport"), { target: { scrollTop: 9_400 } });
    expect(screen.queryByRole("button", { name: /A00000,/ })).not.toBeInTheDocument();
    const later = screen.getByRole("button", { name: /A00095,/ });
    fireEvent.click(later);
    expect(onSelect).toHaveBeenCalledWith(items[95]);
    expect(screen.getAllByTestId("review-queue-row").length).toBeLessThan(30);
  });
});
