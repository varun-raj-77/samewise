import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ReviewQueueItem } from "@samewise/contracts";
import { VirtualReviewQueue } from "./VirtualReviewQueue.js";

function item(index: number): ReviewQueueItem {
  return {
    aRowId: `A${index.toString().padStart(5, "0")}`,
    candidateIds: [`candidate-${index}`], topCandidateId: `candidate-${index}`, topBRowId: `B${index.toString().padStart(5, "0")}`,
    topMatchScore: 0.5, runnerUpMargin: 0.02, candidateCount: 1,
    strongestPositive: null, strongestContradiction: null, collision: false, collisionARowIds: [], strongContradiction: false,
    state: "needs_review", deferred: false, humanDecision: null,
    matcherVersion: "explainable-matcher-v0.2.0", sourceOrder: index,
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
