import {
  CandidateEvidenceDetailSchema,
  ReviewGroupListSchema,
  ReviewGroupPreviewSchema,
  ReviewQueuePageSchema,
  type CandidateEvidenceDetail,
  type CandidateSummary,
  type ReviewFilter,
  type ReviewGroupList,
  type ReviewGroupPreview,
  type ReviewGroupSummary,
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
  onBatchDecision: (groupId: string, decision: "same_entity" | "different_entity") => Promise<RunSummary | null>;
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

async function loadReviewGroups(runId: string): Promise<ReviewGroupList> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/review-groups`);
  if (!response.ok) throw new Error("Review groups could not be loaded.");
  return ReviewGroupListSchema.parse(await response.json());
}

async function loadGroupPreview(runId: string, groupId: string): Promise<ReviewGroupPreview> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/review-groups/${encodeURIComponent(groupId)}?offset=0&limit=20`);
  if (!response.ok) throw new Error("The bounded group preview could not be loaded.");
  return ReviewGroupPreviewSchema.parse(await response.json());
}

export function ReviewWorkspace({ run, initialCandidateId, busy, onDecision, onBatchDecision, onDefer, onUndo, onGoResolution }: ReviewWorkspaceProps) {
  const [viewMode, setViewMode] = useState<"groups" | "individual">(run.reviewProgress.remaining >= 20 ? "groups" : "individual");
  const [groupList, setGroupList] = useState<ReviewGroupList | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [groupPreview, setGroupPreview] = useState<ReviewGroupPreview | null>(null);
  const [batchConfirmed, setBatchConfirmed] = useState(false);
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

  useEffect(() => {
    if (viewMode !== "groups") return;
    let active = true;
    setGroupError(null);
    void loadReviewGroups(run.runId)
      .then((loaded) => { if (active) setGroupList(loaded); })
      .catch((caught) => { if (active) setGroupError(caught instanceof Error ? caught.message : "Review groups could not be loaded."); });
    return () => { active = false; };
  }, [run.runId, run.reviewProgress, run.reviewUndo, viewMode]);

  useEffect(() => {
    if (!selectedGroupId || viewMode !== "groups") { setGroupPreview(null); return; }
    let active = true;
    setBatchConfirmed(false);
    void loadGroupPreview(run.runId, selectedGroupId)
      .then((loaded) => { if (active) setGroupPreview(loaded); })
      .catch((caught) => { if (active) setGroupError(caught instanceof Error ? caught.message : "Group preview could not be loaded."); });
    return () => { active = false; };
  }, [run.runId, selectedGroupId, viewMode]);

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

  async function applyBatch(group: ReviewGroupSummary) {
    if (!group.suggestedDecision || !batchConfirmed || busy) return;
    const updated = await onBatchDecision(group.groupId, group.suggestedDecision);
    if (!updated) return;
    setSelectedGroupId(null);
    setGroupPreview(null);
    setAnnouncement(`${group.suggestedDecision === "same_entity" ? "Same entity" : "Different entities"} applied to ${group.suggestedDecision === "same_entity" ? group.eligibleSameCount : group.eligibleDifferentCount} eligible cases in the reviewed pattern.`);
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

  if (viewMode === "groups") return <ReviewGroupsLanding run={run} groups={groupList} preview={groupPreview} error={groupError} selectedGroupId={selectedGroupId} batchConfirmed={batchConfirmed} busy={busy} onSelectGroup={setSelectedGroupId} onBatchConfirmed={setBatchConfirmed} onApplyBatch={applyBatch} onOpenIndividual={(candidateId) => { setSelectedCandidateId(candidateId); setViewMode("individual"); }} onOpenAll={() => setViewMode("individual")} onUndo={undoRecent} />;

  return <section className="review-product" aria-labelledby="review-workspace-title">
    <header className="review-product-header"><div><p className="eyebrow">Step 3 · Review matches</p><h1 id="review-workspace-title">Could these be the same entity?</h1><p>Compare the source records, then make the identity decision. Values are merged later.</p><button type="button" className="secondary" onClick={() => setViewMode("groups")}>Back to grouped review</button></div><div className="review-progress" aria-label="Overall review progress"><span><strong>{run.reviewProgress.reviewed}</strong> Reviewed</span><span><strong>{run.reviewProgress.remaining}</strong> Remaining</span><span><strong>{run.reviewProgress.deferred}</strong> Deferred</span><div aria-hidden="true"><i style={{ width: `${run.reviewProgress.total ? (run.reviewProgress.reviewed / run.reviewProgress.total) * 100 : 0}%` }} /></div></div></header>
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
          <div className="evidence-hierarchy" aria-label="Why Samewise is unsure"><div className="positive"><small>What agrees</small><strong>{[...selectedCandidate.evidence].sort((left, right) => right.positiveContribution - left.positiveContribution)[0]?.label ?? "No strong agreement"}</strong><span>{[...selectedCandidate.evidence].sort((left, right) => right.positiveContribution - left.positiveContribution)[0]?.explanation}</span></div><div className="negative"><small>Why Samewise is unsure</small><strong>{uncertaintyHeading(selectedCandidate, alternatives.length)}</strong><span>{uncertaintySentence(selectedCandidate, alternatives.length)}</span></div></div>
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

function uncertaintyHeading(candidate: CandidateEvidenceDetail["candidate"], alternativeCount: number): string {
  if (candidate.collision) return "Competing possible match";
  if (alternativeCount > 1 && candidate.runnerUpMargin < 0.04) return "Near-tied alternatives";
  const conflict = [...candidate.evidence].sort((left, right) => right.conflictContribution - left.conflictContribution).find((item) => item.conflictContribution > 0);
  return conflict?.label ?? "Limited combined evidence";
}

function uncertaintySentence(candidate: CandidateEvidenceDetail["candidate"], alternativeCount: number): string {
  if (candidate.collision) return "This record competes with another possible match.";
  if (alternativeCount > 1 && candidate.runnerUpMargin < 0.04) return "Two possible matches have nearly the same evidence.";
  const agreements = candidate.evidence.filter((item) => item.positiveContribution > 0).map((item) => item.label);
  const conflicts = candidate.evidence.filter((item) => item.evidenceClass === "conflict").map((item) => item.label);
  const missing = candidate.evidence.filter((item) => item.evidenceClass.startsWith("missing_")).map((item) => item.label);
  if (agreements.length === 1 && conflicts.length) return `Only ${agreements[0]} agrees. ${conflicts.join(", ")} ${conflicts.length === 1 ? "differs" : "differ"}${missing.length ? `; ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing` : ""}.`;
  if (agreements.length && conflicts.length) return `${agreements.join(" and ")} agree, but ${conflicts.join(" and ")} ${conflicts.length === 1 ? "differs" : "differ"}.`;
  if (missing.length) return `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing, so the available evidence is incomplete.`;
  return "The combined evidence is not strong enough for Samewise to decide automatically.";
}

function patternSentence(group: ReviewGroupSummary): string {
  const exact = group.pattern.filter((item) => item.evidenceClass === "exact_agreement").flatMap((item) => item.labels);
  const partial = group.pattern.filter((item) => item.evidenceClass === "partial_agreement").flatMap((item) => item.labels);
  const conflicts = group.pattern.filter((item) => item.evidenceClass === "conflict").flatMap((item) => item.labels);
  const missing = group.pattern.filter((item) => item.evidenceClass.startsWith("missing_")).flatMap((item) => item.labels);
  return [
    exact.length ? `${exact.join(", ")} agree` : "",
    partial.length ? `${partial.join(", ")} are similar` : "",
    conflicts.length ? `${conflicts.join(", ")} differ` : "",
    missing.length ? `${missing.join(", ")} include missing values` : "",
  ].filter(Boolean).join("; ") || "Limited evidence is available.";
}

function ReviewGroupsLanding({ run, groups, preview, error, selectedGroupId, batchConfirmed, busy, onSelectGroup, onBatchConfirmed, onApplyBatch, onOpenIndividual, onOpenAll, onUndo }: {
  run: RunSummary;
  groups: ReviewGroupList | null;
  preview: ReviewGroupPreview | null;
  error: string | null;
  selectedGroupId: string | null;
  batchConfirmed: boolean;
  busy: boolean;
  onSelectGroup: (groupId: string | null) => void;
  onBatchConfirmed: (confirmed: boolean) => void;
  onApplyBatch: (group: ReviewGroupSummary) => Promise<void>;
  onOpenIndividual: (candidateId: string) => void;
  onOpenAll: () => void;
  onUndo: () => Promise<void>;
}) {
  const workload = groups?.workload;
  return <section className="review-product review-groups-landing" aria-labelledby="review-groups-title">
    <header className="review-product-header"><div><p className="eyebrow">Step 3 · Review matches</p><h1 id="review-groups-title">Matching review</h1><p>Samewise grouped repeated evidence patterns so you can preview and handle safe repetitions without clicking every case.</p></div><div className="review-progress"><span><strong>{run.reviewProgress.reviewed}</strong> Reviewed</span><span><strong>{run.reviewProgress.remaining}</strong> Remaining</span><span><strong>{run.reviewProgress.deferred}</strong> Deferred</span></div></header>
    {run.reviewUndo && <div className={`undo-banner ${run.reviewUndo.canUndo ? "" : "blocked"}`}><span>Last action: <strong>{run.reviewUndo.humanDecision === "same_entity" ? "SAME" : "DIFFERENT"}</strong> · {run.reviewUndo.affectedCount} case{run.reviewUndo.affectedCount === 1 ? "" : "s"}</span>{run.reviewUndo.canUndo ? <button type="button" onClick={() => void onUndo()} disabled={busy}>Undo batch</button> : <span>Undo blocked: {run.reviewUndo.blockedReason}</span>}</div>}
    {error && <div className="warning" role="alert">{error}</div>}
    {workload ? <div className="review-workload-summary" aria-label="Review workload summary"><article><strong>{workload.quickDecisions}</strong><span>Quick decisions</span></article><article><strong>{workload.competingCandidates}</strong><span>Competing candidates</span></article><article><strong>{workload.individualReview + workload.strongContradictions + workload.lowInformationNoise}</strong><span>Individual review</span></article><article><strong>{workload.deferred}</strong><span>Deferred</span></article></div> : <p role="status">Analyzing deterministic review patterns…</p>}
    <div className="review-group-layout">
      <section className="review-group-list" aria-label="Review groups">
        {groups?.groups.map((group) => <article key={group.groupId} className={`review-group-card group-${group.safetyClass}`}>
          <header><span>{group.safetyClass.replaceAll("_", " ")}</span><strong>{group.caseCount} similar case{group.caseCount === 1 ? "" : "s"}</strong></header>
          <p>{patternSentence(group)}</p>
          <dl><div><dt>Candidate context</dt><dd>{group.collision ? "Competing match" : group.alternativeBand === "multiple" ? "Alternatives exist" : "No retained alternative"}</dd></div><div><dt>Suggested action</dt><dd>{group.suggestedDecision ? group.suggestedDecision === "same_entity" ? "Same entity" : "Different entities" : "Review individually"}</dd></div></dl>
          <button type="button" className="secondary" onClick={() => onSelectGroup(group.groupId)}>Preview cases</button>
        </article>)}
        {groups && groups.groups.length === 0 && <div className="review-complete"><h2>No active identity decisions remain</h2><p>Deferred cases remain visible in individual review. Otherwise, continue to Merge values.</p></div>}
        <button type="button" className="secondary" onClick={onOpenAll}>Open individual review and specialist filters</button>
      </section>
      <aside className="review-group-preview" aria-label="Selected group preview">
        {!selectedGroupId && <div className="review-complete"><h2>Preview before applying</h2><p>Select a group to inspect bounded representative cases, exclusions, and the exact effect of a batch decision.</p></div>}
        {selectedGroupId && !preview && <p role="status">Loading a bounded preview…</p>}
        {preview && <><header><span>{preview.group.signatureVersion}</span><h2>{preview.group.caseCount} cases share this evidence pattern</h2><p>{patternSentence(preview.group)}</p></header>
          <div className="group-samples">{preview.items.map((item) => <article key={item.aRowId}><div><strong>{item.aRowId}</strong><span>↔</span><strong>{item.topBRowId}</strong></div><p>{item.strongestPositive ? `${item.strongestPositive.label} supports a match.` : "No strong positive evidence."} {item.strongestContradiction ? `${item.strongestContradiction.label} contradicts it.` : "No dominant contradiction."}</p><small>{Object.entries(item.aIdentity).map(([key, value]) => `${key}: ${value || "missing"}`).join(" · ")}</small><button type="button" className="secondary" onClick={() => onOpenIndividual(item.topCandidateId)}>Inspect full evidence</button></article>)}</div>
          <p className="bounded-note">Showing {preview.page.returned} of {preview.page.total}. Group previews are paged and never send the whole queue to the browser.</p>
          {preview.group.suggestedDecision ? <div className="batch-confirm"><strong>Apply {preview.group.suggestedDecision === "same_entity" ? "Same entity" : "Different entities"} to eligible cases</strong><p>{preview.group.suggestedDecision === "same_entity" ? preview.group.eligibleSameCount : preview.group.eligibleDifferentCount} eligible · {preview.group.caseCount - (preview.group.suggestedDecision === "same_entity" ? preview.group.eligibleSameCount : preview.group.eligibleDifferentCount)} excluded for individual review.</p><label><input type="checkbox" checked={batchConfirmed} onChange={(event) => onBatchConfirmed(event.target.checked)} /> I reviewed this evidence pattern and understand that one human decision will be recorded for each eligible pair.</label><button type="button" className="primary" disabled={!batchConfirmed || busy} onClick={() => void onApplyBatch(preview.group)}>Apply to eligible cases</button></div> : <div className="batch-confirm blocked"><strong>No batch action suggested</strong><p>Collision, near-tie, strong contradiction, or insufficient evidence safeguards require individual review.</p></div>}
        </>}
      </aside>
    </div>
  </section>;
}
