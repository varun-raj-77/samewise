import {
  CandidateEvidenceDetailSchema,
  ReviewQueuePageSchema,
  type CandidateEvidenceDetail,
  type CandidateSummary,
  type ReviewFilter,
  type ReviewQueuePage,
  type ReviewQueueProjectionItem,
  type ReviewSort,
  type RunSummary,
} from "@samewise/contracts";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { VirtualReviewQueue } from "./VirtualReviewQueue.js";
import { evidenceStateLabel, isTypingTarget } from "./review-model.js";

interface ReviewWorkspaceProps {
  run: RunSummary;
  initialCandidateId?: string | null;
  busy: boolean;
  onDecision: (candidateId: string, decision: "same_entity" | "different_entity") => Promise<RunSummary | null>;
  onDefer: (aRowId: string, deferred: boolean) => Promise<RunSummary | null>;
  onUndo: () => Promise<RunSummary | null>;
  onGoResolution: () => void;
}

async function loadReviewPage(runId: string, offset: number, filter: ReviewFilter, sort: ReviewSort, query: string): Promise<ReviewQueuePage> {
  const params = new URLSearchParams({ offset: String(offset), limit: "50", filter, sort });
  if (query) params.set("q", query);
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/review?${params}`);
  if (!response.ok) throw new Error("The review queue could not be loaded.");
  return ReviewQueuePageSchema.parse(await response.json());
}

async function loadDetail(runId: string, candidateId: string): Promise<CandidateEvidenceDetail> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(candidateId)}`);
  if (!response.ok) throw new Error("Candidate evidence could not be loaded.");
  return CandidateEvidenceDetailSchema.parse(await response.json());
}

export function ReviewWorkspace({ run, initialCandidateId, busy, onDecision, onDefer, onUndo, onGoResolution }: ReviewWorkspaceProps) {
  const [filter, setFilter] = useState<ReviewFilter>("unresolved");
  const [sort, setSort] = useState<ReviewSort>("ambiguity");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<ReviewQueuePage | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueRequestVersion, setQueueRequestVersion] = useState(0);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(initialCandidateId ?? null);
  const [detail, setDetail] = useState<CandidateEvidenceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailRequestVersion, setDetailRequestVersion] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const detailCache = useRef(new Map<string, CandidateEvidenceDetail>());
  const decisionHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { setOffset(0); }, [filter, sort, deferredQuery]);

  useEffect(() => {
    let active = true;
    setQueueError(null);
    void loadReviewPage(run.runId, offset, filter, sort, deferredQuery)
      .then((loaded) => {
        if (!active) return;
        setPage(loaded);
        const selectionIsOnPage = loaded.items.some((item) => item.candidates.some((candidate) => candidate.candidateId === selectedCandidateId));
        if (!selectionIsOnPage) setSelectedCandidateId(loaded.items[0] ? preferredCandidate(loaded.items[0]) : null);
      })
      .catch((caught) => { if (active) setQueueError(caught instanceof Error ? caught.message : "The review queue could not be loaded."); });
    return () => { active = false; };
  }, [run.runId, run.reviewProgress, run.reviewUndo, offset, filter, sort, deferredQuery, queueRequestVersion]);

  useEffect(() => {
    if (!selectedCandidateId) { setDetail(null); return; }
    const cached = detailCache.current.get(selectedCandidateId);
    if (cached) { setDetail(cached); setDetailError(null); return; }
    let active = true;
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    void loadDetail(run.runId, selectedCandidateId)
      .then((loaded) => {
        if (!active) return;
        detailCache.current.set(selectedCandidateId, loaded);
        while (detailCache.current.size > 10) detailCache.current.delete(detailCache.current.keys().next().value!);
        setDetail(loaded);
      })
      .catch((caught) => { if (active) setDetailError(caught instanceof Error ? caught.message : "Candidate evidence could not be loaded."); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [run.runId, selectedCandidateId, detailRequestVersion]);

  const selectedItem = useMemo(() => page?.items.find((item) => item.candidates.some((candidate) => candidate.candidateId === selectedCandidateId)) ?? null, [page, selectedCandidateId]);
  const alternatives = selectedItem?.candidates ?? detail?.alternatives ?? [];
  const selectedSummary = alternatives.find((candidate) => candidate.candidateId === selectedCandidateId) ?? alternatives[0] ?? null;
  const selectedCandidate = detail?.candidate.candidateId === selectedCandidateId ? detail.candidate : null;
  const selectedARowId = selectedItem?.aRowId ?? selectedCandidate?.aRowId ?? null;
  const selectedState = selectedItem?.state ?? detail?.reviewState ?? "needs_review";
  const deferred = selectedItem?.deferred ?? detail?.deferred ?? false;
  const candidateDecision = selectedSummary?.humanDecision ?? detail?.humanDecision ?? null;
  const deferredEmptyState = Boolean(page && page.items.length === 0 && run.reviewProgress.deferred > 0 && filter !== "deferred");

  useEffect(() => { if (selectedCandidate) decisionHeadingRef.current?.focus(); }, [selectedCandidate?.candidateId]);

  function selectItem(item: ReviewQueueProjectionItem) { setSelectedCandidateId(preferredCandidate(item)); }

  function viewDeferredCases() { setFilter("deferred"); }

  function selectRelative(delta: number) {
    const items = page?.items ?? [];
    if (!items.length) return;
    const index = Math.max(0, items.findIndex((item) => item.aRowId === selectedARowId));
    const nextIndex = index + delta;
    if (nextIndex < 0 && page?.page.previousOffset != null) { setOffset(page.page.previousOffset); return; }
    if (nextIndex >= items.length && page?.page.nextOffset != null) { setOffset(page.page.nextOffset); return; }
    selectItem(items[(nextIndex + items.length) % items.length]!);
  }

  function advanceFromCurrent() {
    const items = page?.items ?? [];
    const index = items.findIndex((item) => item.aRowId === selectedARowId);
    const next = items[index + 1] ?? items[0];
    if (next) selectItem(next);
  }

  async function decide(decision: "same_entity" | "different_entity") {
    if (!selectedCandidateId || !selectedCandidate || busy || candidateDecision) return;
    const previousA = selectedCandidate.aRowId;
    const previousB = selectedCandidate.bRowId;
    const nextAlternative = decision === "different_entity" ? alternatives.find((candidate) => candidate.candidateId !== selectedCandidateId && !candidate.humanDecision) : null;
    const updated = await onDecision(selectedCandidateId, decision);
    if (!updated) return;
    detailCache.current.delete(selectedCandidateId);
    setAnnouncement(`${decision === "same_entity" ? "Same entity" : "Different entities"} recorded for ${previousA} and ${previousB}.`);
    if (nextAlternative) setSelectedCandidateId(nextAlternative.candidateId); else advanceFromCurrent();
  }

  async function deferCurrent(nextDeferred: boolean) {
    if (!selectedARowId || busy) return;
    const updated = await onDefer(selectedARowId, nextDeferred);
    if (!updated) return;
    if (selectedCandidateId) detailCache.current.delete(selectedCandidateId);
    setAnnouncement(`${selectedARowId} ${nextDeferred ? "deferred" : "returned to the active review queue"}.`);
    if (nextDeferred) advanceFromCurrent();
  }

  async function undoRecent() {
    if (!run.reviewUndo?.canUndo || busy) return;
    const undone = run.reviewUndo;
    const updated = await onUndo();
    if (!updated) return;
    detailCache.current.delete(undone.candidateId);
    setSelectedCandidateId(undone.candidateId);
    setAnnouncement(`Review decision for ${undone.aRowId} and ${undone.bRowId} was undone.`);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey || busy || detailLoading) return;
      const key = event.key.toLocaleLowerCase();
      if (key === "s") { event.preventDefault(); void decide("same_entity"); }
      else if (key === "d") { event.preventDefault(); void decide("different_entity"); }
      else if (key === "e" && selectedState === "needs_review") { event.preventDefault(); void deferCurrent(true); }
      else if (key === "u" && run.reviewUndo?.canUndo) { event.preventDefault(); void undoRecent(); }
      else if (key === "j" || event.key === "ArrowDown") { event.preventDefault(); selectRelative(1); }
      else if (key === "k" || event.key === "ArrowUp") { event.preventDefault(); selectRelative(-1); }
      else if (/^[1-3]$/.test(key)) { const candidate = alternatives[Number(key) - 1]; if (candidate) { event.preventDefault(); setSelectedCandidateId(candidate.candidateId); } }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [alternatives, busy, detailLoading, run.reviewUndo, selectedCandidate, selectedCandidateId, selectedState, page]);

  return <section className="review-product" aria-labelledby="review-workspace-title">
    <header className="review-product-header"><div><p className="eyebrow">Step 3 · Review matches</p><h1 id="review-workspace-title">Could these be the same entity?</h1><p>Compare the source records, then make the identity decision. Values are merged later.</p></div><div className="review-progress" aria-label="Overall review progress"><span><strong>{run.reviewProgress.reviewed}</strong> Reviewed</span><span><strong>{run.reviewProgress.remaining}</strong> Remaining</span><span><strong>{run.reviewProgress.deferred}</strong> Deferred</span><div aria-hidden="true"><i style={{ width: `${run.reviewProgress.total ? (run.reviewProgress.reviewed / run.reviewProgress.total) * 100 : 0}%` }} /></div></div></header>
    {run.reviewUndo && <div className={`undo-banner ${run.reviewUndo.canUndo ? "" : "blocked"}`}><span>Last review: <strong>{run.reviewUndo.humanDecision === "same_entity" ? "SAME" : "DIFFERENT"}</strong> · {run.reviewUndo.aRowId} ↔ {run.reviewUndo.bRowId}</span>{run.reviewUndo.canUndo ? <button type="button" onClick={() => void undoRecent()} disabled={busy}>Undo <kbd>U</kbd></button> : <span role="status">Undo blocked: {run.reviewUndo.blockedReason}</span>}</div>}
    <p className="sr-only" aria-live="polite" role="status">{announcement}</p>
    <div className="review-layout">
      <aside className="review-queue" aria-labelledby="review-queue-title">
        <div className="review-queue-heading"><h2 id="review-queue-title">Review queue</h2><span>{page ? `${page.page.returned} visible / ${page.page.total} filtered / ${run.reviewProgress.total} total` : "Loading…"}</span></div>
        <label className="queue-search"><span className="sr-only">Search review queue</span><input type="search" placeholder="Search row ID or name" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="queue-controls"><label><span>Show {run.reviewProgress.deferred > 0 && <em>{run.reviewProgress.deferred} deferred</em>}</span><select aria-label="Filter review queue" value={filter} onChange={(event) => setFilter(event.target.value as ReviewFilter)}><option value="unresolved">Active unresolved</option><option value="all">All review items</option><option value="deferred">Deferred ({run.reviewProgress.deferred})</option><option value="collision">Has collision</option><option value="contradiction">Has contradiction</option><option value="multiple">Multiple candidates</option></select></label><label><span>Sort</span><select aria-label="Sort review queue" value={sort} onChange={(event) => setSort(event.target.value as ReviewSort)}><option value="ambiguity">Most ambiguous</option><option value="score_desc">Highest score</option><option value="score_asc">Lowest score</option><option value="candidate_count">Most candidates</option><option value="source">Source order</option></select></label></div>
        {queueError ? <div className="warning" role="alert"><span>{queueError}</span><button type="button" onClick={() => setQueueRequestVersion((value) => value + 1)}>Retry</button></div> : page ? <>{page.items.length ? <VirtualReviewQueue items={page.items} selectedARowId={selectedARowId} onSelect={selectItem} /> : deferredEmptyState ? <div className="deferred-queue-empty"><strong>{run.reviewProgress.deferred} review case{run.reviewProgress.deferred === 1 ? " is" : "s are"} deferred</strong><p>Deferred cases are still part of this reconciliation.</p><button type="button" className="secondary" onClick={viewDeferredCases}>View deferred cases</button></div> : <p className="empty">No review items match this view.</p>}<div className="actions" aria-label="Review queue pagination"><button type="button" className="secondary" disabled={page.page.previousOffset === null} onClick={() => setOffset(page.page.previousOffset ?? 0)}>Previous</button><button type="button" className="secondary" disabled={page.page.nextOffset === null} onClick={() => setOffset(page.page.nextOffset ?? offset)}>Next</button></div></> : <p role="status">Loading review queue…</p>}
      </aside>
      <section className="review-case" aria-label="Selected identity case">
        {detailLoading && <div className="review-complete" role="status"><h2>Loading candidate evidence…</h2><p>The queue remains available while full evidence is fetched.</p></div>}
        {detailError && !detailLoading && <div className="review-complete" role="alert"><h2>Candidate evidence unavailable</h2><p>{detailError}</p><button type="button" className="secondary" onClick={() => setDetailRequestVersion((value) => value + 1)}>Retry</button></div>}
        {selectedCandidate && detail && !detailLoading && !detailError ? <>
          <header className="case-heading"><div><span className={`queue-state state-${selectedState}`}>{selectedState.replaceAll("_", " ")}</span><h2 ref={decisionHeadingRef} tabIndex={-1}>Could {selectedCandidate.aRowId} and {selectedCandidate.bRowId} be the same entity?</h2></div><details className="score-block"><summary>Show technical evidence</summary><small>Evidence score</small><strong>{selectedCandidate.matchScore.toFixed(3)}</strong><span>Candidate rank {selectedCandidate.rank} of {alternatives.length} · matcher {run.matcherVersion}</span></details></header>
          {(detail.collisionARowIds.length > 0 || selectedCandidate.collision) && <aside className="collision-warning" aria-label="Candidate collision warning"><strong>Competing possible match</strong><p>{selectedCandidate.bRowId} is also plausible for {detail.collisionARowIds.join(", ") || "another Dataset A record"}.{detail.effectiveCollisionARowIds.length ? ` It is already linked to ${detail.effectiveCollisionARowIds.join(", ")}.` : ""}</p><div className="collision-links">{detail.collisionARowIds.map((aRowId) => { const competingItem = page?.items.find((item) => item.aRowId === aRowId); return competingItem ? <button type="button" key={aRowId} onClick={() => selectItem(competingItem)}>Inspect competing case {aRowId}</button> : null; })}</div><small>Samewise keeps every plausible alternative visible and never overwrites another human decision automatically.</small></aside>}
          {alternatives.length > 1 && <section className="candidate-switcher" aria-labelledby="candidate-options-title"><header><h3 id="candidate-options-title">{alternatives.length - 1} other candidate{alternatives.length === 2 ? " is" : "s are"} plausible</h3><span>Selection alone never records a decision.</span></header><div role="list" aria-label="Dataset B candidate alternatives">{alternatives.map((candidate) => <CandidateOption key={candidate.candidateId} candidate={candidate} selected={candidate.candidateId === selectedCandidate.candidateId} onSelect={() => setSelectedCandidateId(candidate.candidateId)} />)}</div></section>}
          <div className="evidence-hierarchy" aria-label="Why Samewise is unsure"><div className="positive"><small>What agrees</small><strong>{[...selectedCandidate.evidence].sort((left, right) => right.positiveContribution - left.positiveContribution)[0]?.label ?? "No strong agreement"}</strong><span>{[...selectedCandidate.evidence].sort((left, right) => right.positiveContribution - left.positiveContribution)[0]?.explanation}</span></div><div className="negative"><small>Why Samewise is unsure</small><strong>{[...selectedCandidate.evidence].sort((left, right) => right.conflictContribution - left.conflictContribution)[0]?.conflictContribution ? [...selectedCandidate.evidence].sort((left, right) => right.conflictContribution - left.conflictContribution)[0]?.label : "Limited combined evidence"}</strong><span>{selectedCandidate.strongContradiction ? "A strong identifier is different, so Samewise did not silently confirm the match." : "Review the source values before deciding."}</span></div></div>
          <section className="entity-comparison" aria-labelledby="field-evidence-title"><header><h3 id="field-evidence-title">Compare source records</h3><span>Dataset A</span><span>Dataset B</span></header>{selectedCandidate.evidence.map((evidence) => <article className={`field-evidence evidence-${evidence.evidenceClass}`} key={evidence.mappingId}><div><strong>{evidence.label}</strong><span className="evidence-state">{evidenceStateLabel(selectedCandidate, evidence.mappingId)}</span></div><div><span className="dataset-label dataset-a">Dataset A</span><strong>{evidence.aValue || "— Missing"}</strong></div><div><span className="dataset-label dataset-b">Dataset B</span><strong>{evidence.bValue || "— Missing"}</strong></div><details><summary>Show technical evidence</summary><p>{evidence.explanation}</p><dl><div><dt>Field kind</dt><dd>{evidence.fieldKind}</dd></div><div><dt>Contribution</dt><dd>{evidence.contribution.toFixed(3)}</dd></div><div><dt>Weight</dt><dd>{evidence.weight.toFixed(3)}</dd></div>{evidence.features.map((feature) => <div key={feature.name}><dt>{feature.name.replaceAll("_", " ")}</dt><dd>{feature.value.toFixed(3)}</dd></div>)}</dl></details></article>)}</section>
          <details className="raw-records"><summary>All raw source fields</summary><div><RawRecord title={`Dataset A · ${selectedCandidate.aRowId}`} record={selectedCandidate.aRecord} /><RawRecord title={`Dataset B · ${selectedCandidate.bRowId}`} record={selectedCandidate.bRecord} /></div></details>
          <footer className="review-actions" aria-label="Identity review actions"><div><span>Matcher {run.matcherVersion}</span><button type="button" className="shortcut-help" aria-label="Keyboard shortcuts: S same, D different, E defer, U undo, J and K navigate, 1 through 3 select candidates">Shortcuts <kbd>S</kbd> <kbd>D</kbd> <kbd>E</kbd> <kbd>U</kbd> <kbd>J/K</kbd> <kbd>1–3</kbd></button></div>{deferred ? <button type="button" className="secondary" onClick={() => void deferCurrent(false)} disabled={busy}>Return to review</button> : <button type="button" className="secondary" onClick={() => void deferCurrent(true)} disabled={busy || selectedState !== "needs_review"}>Defer / skip <kbd>E</kbd></button>}<button type="button" className="different" aria-label="Different entities" onClick={() => void decide("different_entity")} disabled={busy || !!candidateDecision || selectedState === "reviewed_same" || selectedState === "auto_match"}>Different entities <kbd>D</kbd></button><button type="button" className="same" aria-label="Same entity" onClick={() => void decide("same_entity")} disabled={busy || !!candidateDecision || selectedState === "reviewed_same" || selectedState === "auto_match"}>Same entity <kbd>S</kbd></button></footer>
          {detail.conflicts.length > 0 && <div className="post-identity-conflicts"><span><strong>{detail.conflicts.length} field conflict{detail.conflicts.length === 1 ? "" : "s"}</strong> available after identity was established. Zero values were selected automatically.</span><button type="button" onClick={onGoResolution}>Resolve values separately</button></div>}
        </> : !detailLoading && !detailError && (deferredEmptyState ? <div className="review-complete"><h2>{run.reviewProgress.deferred} review case{run.reviewProgress.deferred === 1 ? " is" : "s are"} deferred</h2><p>Deferred cases are still part of this reconciliation. Use the queue action to view them.</p></div> : <div className="review-complete"><h2>No active review case</h2><p>Change the queue filter or page to inspect another item.</p></div>)}
      </section>
    </div>
  </section>;
}

function preferredCandidate(item: ReviewQueueProjectionItem): string { return item.humanDecision?.candidateId ?? item.candidates.find((candidate) => !candidate.humanDecision)?.candidateId ?? item.topCandidateId; }

function CandidateOption({ candidate, selected, onSelect }: { candidate: CandidateSummary; selected: boolean; onSelect: () => void }) {
  return <div role="listitem"><button type="button" aria-label={`Select candidate rank ${candidate.rank}, ${candidate.bRowId}, score ${candidate.matchScore.toFixed(3)}`} className={selected ? "selected" : ""} aria-pressed={selected} onClick={onSelect}><span><kbd>{candidate.rank <= 3 ? candidate.rank : ""}</kbd><strong>{candidate.bRowId}</strong><small>Rank {candidate.rank}</small></span><b>{candidate.matchScore.toFixed(3)}</b><small>{candidate.strongestPositive ? `${candidate.strongestPositive.label} agrees` : "Limited positive evidence"}{candidate.strongestContradiction ? ` · ${candidate.strongestContradiction.label} conflicts` : ""}</small>{candidate.humanDecision && <em>Human {candidate.humanDecision.humanDecision === "same_entity" ? "SAME" : "DIFFERENT"}</em>}</button></div>;
}

function RawRecord({ title, record }: { title: string; record: Record<string, string> }) { return <article><h3>{title}</h3><dl>{Object.entries(record).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || "— Missing"}</dd></div>)}</dl></article>; }
