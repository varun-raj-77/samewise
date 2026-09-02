import type { ReviewQueueItem, RunView } from "@samewise/contracts";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { VirtualReviewQueue } from "./VirtualReviewQueue.js";
import {
  candidateOptions,
  effectiveLinkForB,
  evidenceStateLabel,
  isTypingTarget,
  reviewItems,
  type ReviewFilter,
  type ReviewSort,
} from "./review-model.js";

interface ReviewWorkspaceProps {
  run: RunView;
  initialCandidateId?: string | null;
  busy: boolean;
  onDecision: (candidateId: string, decision: "same_entity" | "different_entity") => Promise<RunView | null>;
  onDefer: (aRowId: string, deferred: boolean) => Promise<RunView | null>;
  onUndo: () => Promise<RunView | null>;
  onGoResolution: () => void;
}

function initialSelection(run: RunView, candidateId?: string | null): { aRowId: string | null; candidateId: string | null } {
  const candidate = candidateId ? run.candidates.find((item) => item.candidateId === candidateId) : null;
  if (candidate) return { aRowId: candidate.aRowId, candidateId: candidate.candidateId };
  const item = run.reviewQueue.find((entry) => entry.state === "needs_review")
    ?? run.reviewQueue.find((entry) => entry.state === "deferred")
    ?? run.reviewQueue[0];
  return { aRowId: item?.aRowId ?? null, candidateId: item?.topCandidateId ?? null };
}

function nextUnresolved(run: RunView, afterSourceOrder: number): ReviewQueueItem | null {
  const unresolved = run.reviewQueue.filter((item) => item.state === "needs_review");
  return unresolved.find((item) => item.sourceOrder > afterSourceOrder) ?? unresolved[0] ?? null;
}

export function ReviewWorkspace({ run, initialCandidateId, busy, onDecision, onDefer, onUndo, onGoResolution }: ReviewWorkspaceProps) {
  const initial = initialSelection(run, initialCandidateId);
  const [selectedARowId, setSelectedARowId] = useState<string | null>(initial.aRowId);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(initial.candidateId);
  const [filter, setFilter] = useState<ReviewFilter>("unresolved");
  const [sort, setSort] = useState<ReviewSort>("ambiguity");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [announcement, setAnnouncement] = useState("");
  const decisionHeadingRef = useRef<HTMLHeadingElement>(null);

  const visibleItems = useMemo(
    () => reviewItems(run, filter, sort, deferredQuery),
    [run, filter, sort, deferredQuery],
  );
  const selectedItem = run.reviewQueue.find((item) => item.aRowId === selectedARowId) ?? null;
  const options = selectedItem ? candidateOptions(run, selectedItem) : [];
  const selectedCandidate = options.find((candidate) => candidate.candidateId === selectedCandidateId) ?? options[0] ?? null;
  const candidateDecision = selectedCandidate
    ? run.decisions.find((decision) => decision.candidateId === selectedCandidate.candidateId) ?? null
    : null;

  function selectItem(item: ReviewQueueItem) {
    const candidates = candidateOptions(run, item);
    const firstUndecided = candidates.find((candidate) => !run.decisions.some((decision) => decision.candidateId === candidate.candidateId));
    const completedDecision = item.state === "reviewed_same" || item.state === "reviewed_different"
      ? item.humanDecision?.candidateId
      : null;
    setSelectedARowId(item.aRowId);
    setSelectedCandidateId(completedDecision ?? firstUndecided?.candidateId ?? item.humanDecision?.candidateId ?? item.topCandidateId);
  }

  function selectRelative(delta: number) {
    if (!visibleItems.length) return;
    const index = Math.max(0, visibleItems.findIndex((item) => item.aRowId === selectedARowId));
    selectItem(visibleItems[(index + delta + visibleItems.length) % visibleItems.length]!);
  }

  useEffect(() => {
    if (selectedCandidate) decisionHeadingRef.current?.focus();
  }, [selectedCandidate?.candidateId]);

  useEffect(() => {
    if (selectedItem || !visibleItems[0]) return;
    selectItem(visibleItems[0]);
  }, [selectedItem, visibleItems]);

  async function decide(decision: "same_entity" | "different_entity") {
    if (!selectedCandidate || !selectedItem || busy || candidateDecision) return;
    const previousOrder = selectedItem.sourceOrder;
    const previousA = selectedItem.aRowId;
    const previousB = selectedCandidate.bRowId;
    const updated = await onDecision(selectedCandidate.candidateId, decision);
    if (!updated) return;
    setAnnouncement(`${decision === "same_entity" ? "Same entity" : "Different entity"} recorded for ${previousA} and ${previousB}.`);
    const current = updated.reviewQueue.find((item) => item.aRowId === previousA);
    if (decision === "different_entity" && current?.state === "needs_review") {
      const nextCandidate = candidateOptions(updated, current)
        .find((candidate) => !updated.decisions.some((item) => item.candidateId === candidate.candidateId));
      if (nextCandidate) {
        setSelectedCandidateId(nextCandidate.candidateId);
        return;
      }
    }
    const next = nextUnresolved(updated, previousOrder);
    if (next) {
      const nextOptions = candidateOptions(updated, next);
      setSelectedARowId(next.aRowId);
      setSelectedCandidateId(nextOptions.find((candidate) => !updated.decisions.some((item) => item.candidateId === candidate.candidateId))?.candidateId ?? next.topCandidateId);
    } else {
      setSelectedARowId(previousA);
      setSelectedCandidateId(selectedCandidate.candidateId);
    }
  }

  async function deferCurrent(deferred: boolean) {
    if (!selectedItem || busy) return;
    const previousOrder = selectedItem.sourceOrder;
    const updated = await onDefer(selectedItem.aRowId, deferred);
    if (!updated) return;
    setAnnouncement(`${selectedItem.aRowId} ${deferred ? "deferred" : "returned to the active review queue"}.`);
    if (!deferred) return;
    const next = nextUnresolved(updated, previousOrder);
    if (next) {
      setSelectedARowId(next.aRowId);
      setSelectedCandidateId(next.topCandidateId);
    }
  }

  async function undoRecent() {
    if (!run.reviewUndo?.canUndo || busy) return;
    const undone = run.reviewUndo;
    const updated = await onUndo();
    if (!updated) return;
    setSelectedARowId(undone.aRowId);
    setSelectedCandidateId(undone.candidateId);
    setAnnouncement(`Review decision for ${undone.aRowId} and ${undone.bRowId} was undone.`);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey || busy) return;
      const key = event.key.toLocaleLowerCase();
      if (key === "s") { event.preventDefault(); void decide("same_entity"); }
      else if (key === "d") { event.preventDefault(); void decide("different_entity"); }
      else if (key === "e" && selectedItem?.state === "needs_review") { event.preventDefault(); void deferCurrent(true); }
      else if (key === "u" && run.reviewUndo?.canUndo) { event.preventDefault(); void undoRecent(); }
      else if (key === "j" || event.key === "ArrowDown") { event.preventDefault(); selectRelative(1); }
      else if (key === "k" || event.key === "ArrowUp") { event.preventDefault(); selectRelative(-1); }
      else if (/^[1-3]$/.test(key)) {
        const candidate = options[Number(key) - 1];
        if (candidate) { event.preventDefault(); setSelectedCandidateId(candidate.candidateId); }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, options, run, selectedCandidate, selectedItem, visibleItems]);

  const collisionCandidates = selectedCandidate
    ? run.candidates.filter((candidate) => candidate.bRowId === selectedCandidate.bRowId && candidate.aRowId !== selectedCandidate.aRowId)
    : [];
  const effectiveCollisions = selectedCandidate ? effectiveLinkForB(run, selectedCandidate.bRowId)
    .filter((candidate) => candidate.aRowId !== selectedCandidate.aRowId) : [];
  const selectedConflicts = selectedCandidate
    ? run.conflicts.filter((conflict) => conflict.candidateId === selectedCandidate.candidateId)
    : [];

  return <section className="review-product" aria-labelledby="review-workspace-title">
    <header className="review-product-header">
      <div>
        <p className="eyebrow">Step 5 · Human identity review</p>
        <h1 id="review-workspace-title">Resolve identity uncertainty.</h1>
        <p>Identity first. Values second. Scores are evidence scores, not probabilities.</p>
      </div>
      <div className="review-progress" aria-label="Overall review progress">
        <span><strong>{run.reviewProgress.reviewed}</strong> Reviewed</span>
        <span><strong>{run.reviewProgress.remaining}</strong> Remaining</span>
        <span><strong>{run.reviewProgress.deferred}</strong> Deferred</span>
        <div aria-hidden="true"><i style={{ width: `${run.reviewProgress.total ? (run.reviewProgress.reviewed / run.reviewProgress.total) * 100 : 0}%` }} /></div>
      </div>
    </header>

    {run.reviewUndo && <div className={`undo-banner ${run.reviewUndo.canUndo ? "" : "blocked"}`}>
      <span>Last review: <strong>{run.reviewUndo.humanDecision === "same_entity" ? "SAME" : "DIFFERENT"}</strong> · {run.reviewUndo.aRowId} ↔ {run.reviewUndo.bRowId}</span>
      {run.reviewUndo.canUndo
        ? <button type="button" onClick={() => void undoRecent()} disabled={busy}>Undo <kbd>U</kbd></button>
        : <span role="status">Undo blocked: {run.reviewUndo.blockedReason}</span>}
    </div>}
    <p className="sr-only" aria-live="polite" role="status">{announcement}</p>

    <div className="review-layout">
      <aside className="review-queue" aria-labelledby="review-queue-title">
        <div className="review-queue-heading"><h2 id="review-queue-title">Review queue</h2><span>{visibleItems.length} visible / {run.reviewProgress.total} total</span></div>
        <label className="queue-search"><span className="sr-only">Search review queue</span><input type="search" placeholder="Search row ID or name" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="queue-controls">
          <label><span>Show</span><select aria-label="Filter review queue" value={filter} onChange={(event) => setFilter(event.target.value as ReviewFilter)}>
            <option value="unresolved">Active unresolved</option><option value="all">All review items</option><option value="deferred">Deferred</option><option value="collision">Has collision</option><option value="contradiction">Has contradiction</option><option value="multiple">Multiple candidates</option>
          </select></label>
          <label><span>Sort</span><select aria-label="Sort review queue" value={sort} onChange={(event) => setSort(event.target.value as ReviewSort)}>
            <option value="ambiguity">Most ambiguous</option><option value="score_desc">Highest score</option><option value="score_asc">Lowest score</option><option value="candidate_count">Most candidates</option><option value="source">Source order</option>
          </select></label>
        </div>
        {visibleItems.length
          ? <VirtualReviewQueue items={visibleItems} selectedARowId={selectedARowId} onSelect={selectItem} />
          : <p className="empty">No review items match this view.</p>}
      </aside>

      <section className="review-case" aria-label="Selected identity case">
        {selectedCandidate && selectedItem ? <>
          <header className="case-heading">
            <div><span className={`queue-state state-${selectedItem.state}`}>{selectedItem.state.replaceAll("_", " ")}</span><h2 ref={decisionHeadingRef} tabIndex={-1}>Are {selectedCandidate.aRowId} and {selectedCandidate.bRowId} the same entity?</h2></div>
            <div className="score-block"><small>Match score</small><strong>{selectedCandidate.matchScore.toFixed(3)}</strong><span>Rank {selectedCandidate.rank} of {options.length}</span></div>
          </header>

          {(collisionCandidates.length > 0 || selectedCandidate.collision) && <aside className="collision-warning" aria-label="Candidate collision warning">
            <strong>⚠ Shared candidate — inspect before confirming</strong>
            <p>{selectedCandidate.bRowId} is also a candidate for {collisionCandidates.map((candidate) => candidate.aRowId).join(", ") || "another A row"}.
              {effectiveCollisions.length ? ` It is already an effective link for ${effectiveCollisions.map((candidate) => candidate.aRowId).join(", ")}.` : " No competing effective link is being reassigned."}</p>
            <div className="collision-links">{[...new Set(collisionCandidates.map((candidate) => candidate.aRowId))].map((aRowId) => {
              const competingItem = run.reviewQueue.find((item) => item.aRowId === aRowId);
              return competingItem ? <button type="button" key={aRowId} onClick={() => selectItem(competingItem)}>Inspect competing case {aRowId}</button> : null;
            })}</div>
            <small>This run does not enforce global one-to-one identity. Samewise never overwrites another human decision automatically.</small>
          </aside>}

          <section className="candidate-switcher" aria-labelledby="candidate-options-title">
            <header><h3 id="candidate-options-title">Candidate alternatives</h3><span>Selection alone never records a decision.</span></header>
            <div role="list" aria-label="Dataset B candidate alternatives">{options.map((candidate) => {
              const decision = run.decisions.find((item) => item.candidateId === candidate.candidateId);
              const agreement = [...candidate.evidence].sort((left, right) => right.positiveContribution - left.positiveContribution)[0];
              const contradiction = [...candidate.evidence].sort((left, right) => right.conflictContribution - left.conflictContribution)[0];
              return <div role="listitem" key={candidate.candidateId}><button type="button" aria-label={`Select candidate rank ${candidate.rank}, ${candidate.bRowId}, score ${candidate.matchScore.toFixed(3)}`} className={candidate.candidateId === selectedCandidate.candidateId ? "selected" : ""} aria-pressed={candidate.candidateId === selectedCandidate.candidateId} onClick={() => setSelectedCandidateId(candidate.candidateId)}>
                  <span><kbd>{candidate.rank <= 3 ? candidate.rank : ""}</kbd><strong>{candidate.bRowId}</strong><small>Rank {candidate.rank}</small></span>
                  <b>{candidate.matchScore.toFixed(3)}</b>
                  <small>{agreement?.positiveContribution ? `${agreement.label} agrees` : "Limited positive evidence"}{contradiction?.conflictContribution ? ` · ${contradiction.label} conflicts` : ""}</small>
                  {decision && <em>Human {decision.humanDecision === "same_entity" ? "SAME" : "DIFFERENT"}</em>}
                </button></div>;
            })}</div>
          </section>

          <div className="evidence-hierarchy" aria-label="Evidence summary">
            <div className="positive"><small>Strongest evidence</small><strong>{[...selectedCandidate.evidence].sort((left, right) => right.positiveContribution - left.positiveContribution)[0]?.label ?? "No positive evidence"}</strong><span>{[...selectedCandidate.evidence].sort((left, right) => right.positiveContribution - left.positiveContribution)[0]?.explanation}</span></div>
            <div className="negative"><small>Potential conflict</small><strong>{[...selectedCandidate.evidence].sort((left, right) => right.conflictContribution - left.conflictContribution)[0]?.conflictContribution ? [...selectedCandidate.evidence].sort((left, right) => right.conflictContribution - left.conflictContribution)[0]?.label : "No weighted contradiction"}</strong><span>{selectedCandidate.strongContradiction ? "Strong identifier contradiction blocks auto-match." : "Review all fields before deciding."}</span></div>
          </div>

          <section className="entity-comparison" aria-labelledby="field-evidence-title">
            <header><h3 id="field-evidence-title">Mapped identity evidence</h3><span>Dataset A raw value</span><span>Dataset B raw value</span></header>
            {selectedCandidate.evidence.map((evidence) => <article className={`field-evidence evidence-${evidence.evidenceClass}`} key={evidence.mappingId}>
              <div><strong>{evidence.label}</strong><span className="evidence-state">{evidenceStateLabel(selectedCandidate, evidence.mappingId)}</span><small>{evidence.fieldKind} · contribution {evidence.contribution >= 0 ? "+" : ""}{evidence.contribution.toFixed(3)}</small></div>
              <div><span className="dataset-label dataset-a">Dataset A</span><strong>{evidence.aValue || "— Missing"}</strong>{evidence.normalizedA && evidence.normalizedA !== evidence.aValue && <small>Normalized: {evidence.normalizedA}</small>}</div>
              <div><span className="dataset-label dataset-b">Dataset B</span><strong>{evidence.bValue || "— Missing"}</strong>{evidence.normalizedB && evidence.normalizedB !== evidence.bValue && <small>Normalized: {evidence.normalizedB}</small>}</div>
              <details><summary>Feature detail and matcher explanation</summary><p>{evidence.explanation}</p><dl><div><dt>Weight</dt><dd>{evidence.weight.toFixed(3)}</dd></div><div><dt>Positive</dt><dd>{evidence.positiveContribution.toFixed(3)}</dd></div><div><dt>Conflict</dt><dd>{evidence.conflictContribution.toFixed(3)}</dd></div>{evidence.features.map((feature) => <div key={feature.name}><dt>{feature.name.replaceAll("_", " ")}</dt><dd>{feature.value.toFixed(3)}</dd></div>)}</dl></details>
            </article>)}
          </section>

          <details className="raw-records"><summary>All raw source fields</summary><div><RawRecord title={`Dataset A · ${selectedCandidate.aRowId}`} record={selectedCandidate.aRecord} /><RawRecord title={`Dataset B · ${selectedCandidate.bRowId}`} record={selectedCandidate.bRecord} /></div></details>

          <footer className="review-actions" aria-label="Identity review actions">
            <div><span>Matcher {run.matcherVersion}</span><button type="button" className="shortcut-help" aria-label="Keyboard shortcuts: S same, D different, E defer, U undo, J and K navigate, 1 through 3 select candidates">Shortcuts <kbd>S</kbd> <kbd>D</kbd> <kbd>E</kbd> <kbd>U</kbd> <kbd>J/K</kbd> <kbd>1–3</kbd></button></div>
            {selectedItem.state === "deferred" ? <button type="button" className="secondary" onClick={() => void deferCurrent(false)} disabled={busy}>Return to review</button> : <button type="button" className="secondary" onClick={() => void deferCurrent(true)} disabled={busy || selectedItem.state !== "needs_review"}>Defer / skip <kbd>E</kbd></button>}
            <button type="button" className="different" aria-label="Different entity" onClick={() => void decide("different_entity")} disabled={busy || !!candidateDecision || selectedItem.state === "reviewed_same"}>Different entity <kbd>D</kbd></button>
            <button type="button" className="same" aria-label="Same entity" onClick={() => void decide("same_entity")} disabled={busy || !!candidateDecision || selectedItem.state === "reviewed_same"}>Same entity <kbd>S</kbd></button>
          </footer>
          {selectedConflicts.length > 0 && <div className="post-identity-conflicts"><span><strong>{selectedConflicts.length} field conflict{selectedConflicts.length === 1 ? "" : "s"}</strong> created after SAME. Zero values were selected automatically.</span><button type="button" onClick={onGoResolution}>Resolve values separately</button></div>}
        </> : <div className="review-complete"><h2>No active review case</h2><p>Change the queue filter to inspect deferred or reviewed items.</p></div>}
      </section>
    </div>
  </section>;
}

function RawRecord({ title, record }: { title: string; record: Record<string, string> }) {
  return <article><h3>{title}</h3><dl>{Object.entries(record).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || "— Missing"}</dd></div>)}</dl></article>;
}
