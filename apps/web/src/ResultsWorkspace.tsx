import { ResultsPageSchema, type ResultsPage, type RunSummary } from "@samewise/contracts";
import { useEffect, useState } from "react";

interface ResultsWorkspaceProps {
  run: RunSummary;
  onReview: (candidateId: string) => void;
  onResolution: () => void;
  onOpenReview: () => void;
  onExport: () => void;
}

async function loadPage(runId: string, offset: number): Promise<ResultsPage> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/results?offset=${offset}&limit=50`);
  if (!response.ok) throw new Error("Results could not be loaded.");
  return ResultsPageSchema.parse(await response.json());
}

function identityLabel(record: Record<string, string> | null): string {
  if (!record) return "No candidate";
  return Object.values(record).find((value) => value.trim()) ?? "Identity fields empty";
}

export function ResultsWorkspace({ run, onReview, onResolution, onOpenReview, onExport }: ResultsWorkspaceProps) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ResultsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);
  const unresolvedReviewCount = run.reviewProgress.remaining + run.reviewProgress.deferred;

  useEffect(() => {
    let active = true;
    setPage(null);
    setError(null);
    void loadPage(run.runId, offset)
      .then((loaded) => { if (active) setPage(loaded); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Results could not be loaded."); });
    return () => { active = false; };
  }, [run.runId, run.reviewProgress, offset, requestVersion]);

  return <section aria-labelledby="results-title">
    <p className="eyebrow">Step 4 · Explainable matcher</p>
    <h1 id="results-title">Evidence first, uncertainty visible.</h1>
    <p className="lede">Match scores are deterministic evidence scores, not probabilities. Auto-matches remain system proposals; review and human confirmation stay distinct. Only B means no identity link is established, even when the row appears as an alternative.</p>
    {unresolvedReviewCount > 0 && <aside className="review-handoff" aria-labelledby="review-handoff-title"><div><small>Identity review required</small><h2 id="review-handoff-title">{unresolvedReviewCount} identity decision{unresolvedReviewCount === 1 ? "" : "s"} need{unresolvedReviewCount === 1 ? "s" : ""} review</h2><p>Resolve uncertain identities before trusted output can be prepared.</p></div><button className="primary" onClick={onOpenReview}>Review uncertain matches</button></aside>}
    <div className="summary-grid"><Metric label="Matched" value={run.summary?.matched ?? 0} /><Metric label="Needs review" value={run.summary?.needsReview ?? 0} accent /><Metric label="Only A" value={run.summary?.onlyA ?? 0} /><Metric label="Only B" value={run.summary?.onlyB ?? 0} /></div>
    <div className="result-list">
      <div className="review-queue-heading"><h2>Bounded results</h2><span>{page ? `${page.page.offset + 1}–${page.page.offset + page.page.returned} / ${page.page.total}` : "Loading…"}</span></div>
      {error && <div className="warning" role="alert"><span>{error}</span><button type="button" className="secondary" onClick={() => setRequestVersion((value) => value + 1)}>Retry</button></div>}
      {!error && !page && <p role="status">Loading result page…</p>}
      {page?.items.map((item) => <button
        className="candidate-row"
        key={item.aRowId}
        disabled={!item.topCandidate || item.status === "unmatched"}
        onClick={() => item.topCandidate && onReview(item.topCandidate.candidateId)}
      >
        <span><strong>{item.aRowId}</strong> ↔ <strong>{item.topCandidate?.bRowId ?? "Only A"}</strong><small>{identityLabel(item.aIdentity)} · {identityLabel(item.topBIdentity)} · {item.status.replaceAll("_", " ")}{item.alternativeCount ? ` · ${item.alternativeCount} alternative${item.alternativeCount === 1 ? "" : "s"}` : ""}</small></span>
        <b>{item.topCandidate ? item.topCandidate.matchScore.toFixed(3) : "—"}</b>
      </button>)}
      {page && page.items.length === 0 && <p className="empty">No result rows are available.</p>}
      {page && <div className="actions" aria-label="Result pagination"><button type="button" className="secondary" disabled={page.page.previousOffset === null} onClick={() => setOffset(page.page.previousOffset ?? 0)}>Previous</button><button type="button" className="secondary" disabled={page.page.nextOffset === null} onClick={() => setOffset(page.page.nextOffset ?? offset)}>Next</button></div>}
    </div>
    <div className="actions"><button className="secondary" onClick={onResolution}>View field conflicts ({run.conflictSummary.unresolved})</button><button className="secondary" onClick={onOpenReview} disabled={run.reviewProgress.total === 0}>Open review workspace</button><button className="primary" onClick={onExport}>Prepare export</button></div>
  </section>;
}

function Metric({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return <article className={accent ? "metric accent" : "metric"}><small>{label}</small><strong>{value}</strong></article>;
}
