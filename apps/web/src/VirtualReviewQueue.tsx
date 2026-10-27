import type { ReviewQueueProjectionItem } from "@samewise/contracts";
import { useEffect, useRef, useState } from "react";

const ROW_HEIGHT = 94;
const OVERSCAN = 5;

interface VirtualReviewQueueProps {
  items: ReviewQueueProjectionItem[];
  selectedARowId: string | null;
  onSelect: (item: ReviewQueueProjectionItem) => void;
  pageKey?: string;
}

export function VirtualReviewQueue({ items, selectedARowId, onSelect, pageKey }: VirtualReviewQueueProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(620);
  useEffect(() => {
    // Previous page scroll positions otherwise leave fresh filtered pages blank.
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [pageKey]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => setViewportHeight(viewport.clientHeight || 620);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const start = Math.max(0, Math.min(Math.max(0, items.length - 1), Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN));
  const end = Math.min(items.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const visible = items.slice(start, end);

  return <div
    className="review-queue-viewport"
    ref={viewportRef}
    onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    data-testid="review-queue-viewport"
  >
    <div className="review-queue-spacer" style={{ height: items.length * ROW_HEIGHT }}>
      {visible.map((item, offset) => <button
        type="button"
        key={item.aRowId}
        className={`review-queue-row ${selectedARowId === item.aRowId ? "selected" : ""}`}
        style={{ transform: `translateY(${(start + offset) * ROW_HEIGHT}px)` }}
        aria-current={selectedARowId === item.aRowId ? "true" : undefined}
        aria-label={`${item.aRowId}, candidate ${item.topBRowId}, score ${item.topMatchScore.toFixed(3)}, ${item.state.replaceAll("_", " ")}`}
        onClick={() => onSelect(item)}
        data-testid="review-queue-row"
      >
        <span className="queue-row-main"><strong>{item.aRowId}</strong><small>Top candidate {item.topBRowId}</small></span>
        <span className={`queue-state state-${item.state}`}>{item.state.replaceAll("_", " ")}</span>
        <span className="queue-row-evidence">{item.strongestPositive ? `${item.strongestPositive.label} agrees` : "No positive evidence"}</span>
        <span className="queue-row-meta"><b>{item.topMatchScore.toFixed(3)}</b><small>{item.candidateCount} candidate{item.candidateCount === 1 ? "" : "s"}</small></span>
        {(item.collision || item.strongestContradiction) && <span className="queue-flags">{item.collision ? "⚠ Shared B" : ""}{item.collision && item.strongestContradiction ? " · " : ""}{item.strongestContradiction ? "! Conflict" : ""}</span>}
      </button>)}
    </div>
  </div>;
}
