import { IdentityExplanationSchema, ResultsPageSchema, type IdentityExplanation, type ResultsPage, type RunSummary } from "@samewise/contracts";
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

async function loadExplanation(runId: string, aRowId: string): Promise<IdentityExplanation> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/identity-explanations/${encodeURIComponent(aRowId)}`);
  if (!response.ok) throw new Error("Recorded explanation could not be loaded.");
  return IdentityExplanationSchema.parse(await response.json());
}

function reasonText(reason: IdentityExplanation["reasonCode"]): string {
  switch (reason) {
    case "linked_automatically": return "The matcher established this link automatically from its recorded evidence. This is not a guarantee of identity.";
    case "linked_by_human": return "A reviewer explicitly confirmed these records refer to the same entity.";
    case "rejected_by_human": return "A reviewer explicitly marked this proposed pair as different entities.";
    case "other_candidate_linked": return "A different candidate is linked to this Dataset A row. This pair remains a retained alternative, not a confirmed non-match.";
    case "candidate_awaiting_review": return "The matcher retained this possible pair but has not established its identity. Human review is required.";
    case "alternative_not_selected": return "The matcher retained this alternative but it was not the established link. This is not proof of a different entity.";
    case "no_candidate_retained": return "No candidate evidence was retained for this pair or row. It might have been blocked, pruned, or never scored; Samewise cannot identify the exact cause from this run.";
  }
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
  const [explanationRowId, setExplanationRowId] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<IdentityExplanation | null>(null);
  const [explanationError, setExplanationError] = useState<string | null>(null);
  const [explanationLoading, setExplanationLoading] = useState(false);

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

  useEffect(() => {
    let active = true;
    setExplanation(null);
    setExplanationError(null);
    if (!explanationRowId || !page?.items.some((item) => item.aRowId === explanationRowId)) {
      setExplanationLoading(false);
      return () => { active = false; };
    }
    setExplanationLoading(true);
    void loadExplanation(run.runId, explanationRowId)
      .then((loaded) => { if (active) setExplanation(loaded); })
      .catch(() => { if (active) setExplanationError("The recorded explanation could not be loaded."); })
      .finally(() => { if (active) setExplanationLoading(false); });
    return () => { active = false; };
  }, [run.runId, explanationRowId, page, requestVersion]);

  return <section aria-labelledby="results-title">
    <p className="eyebrow">Step 3 · Review matches</p>
    <h1 id="results-title">Matching complete.</h1>
    <p className="lede">Samewise found likely links and kept uncertain cases for your decision.</p>
    {unresolvedReviewCount > 0 && <aside className="review-handoff" aria-labelledby="review-handoff-title"><div><small>Your decision is needed</small><h2 id="review-handoff-title">{unresolvedReviewCount} uncertain match{unresolvedReviewCount === 1 ? "" : "es"}</h2><p>Review these before choosing merge rules.</p></div><button className="primary" onClick={onOpenReview}>Review {unresolvedReviewCount} uncertain match{unresolvedReviewCount === 1 ? "" : "es"}</button></aside>}
    <div className="summary-grid"><Metric label="Matched automatically / confirmed" value={run.summary?.matched ?? 0} /><Metric label="Need your review" value={unresolvedReviewCount} accent /><Metric label="No match found in Dataset B" value={run.summary?.onlyA ?? 0} /><Metric label="No match found in Dataset A" value={run.summary?.onlyB ?? 0} /></div>
    <details className="result-list">
      <summary>Inspect all results</summary><div className="review-queue-heading"><h2>Match summary</h2><span>{page ? `${page.page.offset + 1}–${page.page.offset + page.page.returned} / ${page.page.total}` : "Loading…"}</span></div>
      {error && <div className="warning" role="alert"><span>{error}</span><button type="button" className="secondary" onClick={() => setRequestVersion((value) => value + 1)}>Retry</button></div>}
      {!error && !page && <p role="status">Loading result page…</p>}
      {page?.items.map((item) => <div className="explained-result" key={item.aRowId}>
        <div className="explained-result-row">
          <button className="candidate-row"
            disabled={!item.topCandidate || item.status === "unmatched"}
            onClick={() => item.topCandidate && onReview(item.topCandidate.candidateId)}
          >
            <span><strong>{item.aRowId}</strong> ↔ <strong>{item.topCandidate?.bRowId ?? "No match found"}</strong><small>{identityLabel(item.aIdentity)} · {identityLabel(item.topBIdentity)} · {item.status === "unmatched" ? "no match found" : item.status.replaceAll("_", " ")}{item.alternativeCount ? ` · ${item.alternativeCount} other plausible candidate${item.alternativeCount === 1 ? "" : "s"}` : ""}</small></span>
            <b>{item.topCandidate ? item.topCandidate.matchScore.toFixed(3) : "—"}</b>
          </button>
          <button type="button" className="secondary result-explain-toggle"
            aria-expanded={explanationRowId === item.aRowId}
            onClick={() => setExplanationRowId((current) => current === item.aRowId ? null : item.aRowId)}
          >{explanationRowId === item.aRowId ? "Close explanation" : "Why this result?"}</button>
        </div>
        {explanationRowId === item.aRowId && <section className="result-explanation" aria-label={`Why ${item.aRowId} received this outcome`}>
          {explanationLoading && <p role="status">Loading recorded evidence…</p>}
          {explanationError && <p role="alert">{explanationError}</p>}
          {explanation && !explanationLoading && <>
            <strong>{reasonText(explanation.reasonCode)}</strong>
            {explanation.linkedBRowId && <p>Established link: Dataset B row {explanation.linkedBRowId}.</p>}
            {explanation.matchScore !== null && <p>Recorded match score: {explanation.matchScore.toFixed(3)} · candidate rank {explanation.candidateRank} · {explanation.candidateCount} retained candidate{explanation.candidateCount === 1 ? "" : "s"}. The score is not a calibrated probability.</p>}
            {(explanation.hasCollision || explanation.strongContradiction) && <p>{explanation.hasCollision ? "A competing possible match was recorded. " : ""}{explanation.strongContradiction ? "The matcher recorded a strong contradiction." : ""}</p>}
            {explanation.fieldEvidence.length > 0 && <ul>{explanation.fieldEvidence.map((field) =>
              <li key={field.mappingId}><strong>{field.label}:</strong> {field.explanation} <small>({field.evidenceClass.replaceAll("_", " ")}, positive {field.positiveContribution.toFixed(3)}, conflict {field.conflictContribution.toFixed(3)})</small></li>,
            )}</ul>}
            {explanation.retainedEvidenceCount > explanation.fieldEvidence.length && <small>Showing {explanation.fieldEvidence.length} of {explanation.retainedEvidenceCount} retained field explanations. Open candidate review for complete evidence.</small>}
            {explanation.blockingRuleIds.length > 0 && <details><summary>Candidate-generation provenance</summary><code>{explanation.blockingRuleIds.join(", ")}</code></details>}
            <small>Matcher {explanation.matcherVersion} · candidate engine {explanation.candidateEngineVersion}. This describes recorded decisions, not independently verified ground truth.</small>
          </>}
        </section>}
      </div>)}
      {page && page.items.length === 0 && <p className="empty">No result rows are available.</p>}
      {page && <div className="actions" aria-label="Result pagination"><button type="button" className="secondary" disabled={page.page.previousOffset === null} onClick={() => setOffset(page.page.previousOffset ?? 0)}>Previous</button><button type="button" className="secondary" disabled={page.page.nextOffset === null} onClick={() => setOffset(page.page.nextOffset ?? offset)}>Next</button></div>}
    </details>
    <div className="actions">{unresolvedReviewCount > 0 ? <span role="status">Merge values and trusted Export unlock after identity review.</span> : run.conflictSummary.unresolved > 0 ? <><button className="primary" onClick={onResolution}>Continue to Merge values</button><button className="secondary" onClick={onOpenReview} disabled={run.reviewProgress.total === 0}>Inspect reviewed matches</button></> : <><button className="primary" onClick={onExport}>Continue to Export</button><button className="secondary" onClick={onResolution}>Inspect merge values</button></>}</div>
  </section>;
}

function Metric({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) {
  return <article className={accent ? "metric accent" : "metric"}><small>{label}</small><strong>{value}</strong></article>;
}
