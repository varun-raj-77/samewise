import { CollisionContextPageSchema, type CollisionContextPage } from "@samewise/contracts";
import { useEffect, useState } from "react";

interface CollisionInspectorProps {
  runId: string;
  bRowId: string;
  currentCandidateId: string;
  revision: string;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onInspectCandidate: (candidateId: string) => void;
}

async function fetchContext(runId: string, bRowId: string, offset: number): Promise<CollisionContextPage> {
  const params = new URLSearchParams({ bRowId, offset: String(offset), limit: "20" });
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/collision-context?${params}`);
  if (!response.ok) throw new Error("Could not load competing candidate evidence.");
  return CollisionContextPageSchema.parse(await response.json());
}

/**
 * Inspect all retained A candidates for one B without granting selection any
 * decision authority. All decisions remain in ReviewWorkspace's guarded API.
 */
export function CollisionInspector({ runId, bRowId, currentCandidateId, revision, defaultExpanded = false, onExpandedChange, onInspectCandidate }: CollisionInspectorProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<CollisionContextPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setExpanded(defaultExpanded);
    setOffset(0);
    setPage(null);
    setError(null);
  }, [runId, bRowId, defaultExpanded]);

  useEffect(() => {
    if (!expanded) return;
    let active = true;
    setLoading(true);
    setError(null);
    void fetchContext(runId, bRowId, offset)
      .then((value) => { if (active) setPage(value); })
      .catch((caught) => { if (active) { setPage(null); setError(caught instanceof Error ? caught.message : "Collision details unavailable."); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [expanded, runId, bRowId, offset, revision, retry]);

  return <div className="collision-inspector">
    <button type="button" className="secondary" aria-expanded={expanded} onClick={() => { setExpanded(!expanded); onExpandedChange?.(!expanded); }}>
      {expanded ? "Hide competing candidates" : "Inspect all competing candidates"}
    </button>
    {expanded && <section aria-label={`Competing candidates for ${bRowId}`} className="collision-inspector-panel">
      {loading && <p role="status">Loading retained candidates…</p>}
      {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>Retry contenders</button></div>}
      {page && !error && <>
        <header>
          <strong>{page.distinctARowCount} Dataset A record{page.distinctARowCount === 1 ? "" : "s"} retain {page.bRowId}</strong>
          <span>{page.claimedByARowId ? `Currently linked to ${page.claimedByARowId}` : "No identity link established for this B record"}</span>
          <span>{Object.entries(page.bIdentity).filter(([,value]) => value).slice(0, 2).map(([name, value]) => `${name}: ${value}`).join(" · ") || "No mapped B identity value"}</span>
        </header>
        <p>Candidate rankings show evidence, not a confirmed winner. Open a case to inspect fields and make its identity decision separately.</p>
        <ol>
          {page.items.map((item) => <li key={item.candidate.candidateId}>
            <div><strong>{item.aRowId}</strong><span>Rank {item.candidate.rank} · Score {item.candidate.matchScore.toFixed(3)}</span></div>
            <p>{Object.entries(item.aIdentity).filter(([,value]) => value).slice(0, 2).map(([name, value]) => `${name}: ${value}`).join(" · ") || "No mapped identity value"}</p>
            <small>{item.candidate.strongestPositive ? `${item.candidate.strongestPositive.label} agrees` : "Limited positive evidence"}{item.candidate.strongestContradiction ? ` · ${item.candidate.strongestContradiction.label} conflicts` : ""}</small>
            {item.candidate.humanDecision && <small>Recorded human decision: {item.candidate.humanDecision.humanDecision === "same_entity" ? "SAME" : "DIFFERENT"}</small>}
            <div className="collision-contender-status">
              <span>{item.identityStatus === "linked_here" ? `Linked to this B (${item.linkSource === "human" ? "human confirmed" : "matcher"})`
                : item.identityStatus === "linked_elsewhere" ? `Already linked to ${item.linkedElsewhereBRowId}`
                  : item.identityStatus === "rejected_pair" ? "Human marked DIFFERENT" : "Identity remains unresolved"}</span>
              <button type="button" aria-label={`Inspect ${item.aRowId} candidate for ${bRowId}`} aria-current={item.candidate.candidateId === currentCandidateId ? "true" : undefined}
                disabled={item.candidate.candidateId === currentCandidateId}
                onClick={() => onInspectCandidate(item.candidate.candidateId)}>
                {item.candidate.candidateId === currentCandidateId ? "Viewing" : "Inspect evidence"}
              </button>
            </div>
          </li>)}
        </ol>
        {page.page.total > page.page.returned && <p className="collision-page-info">Showing {page.page.offset + 1}–{page.page.offset + page.page.returned} of {page.page.total} candidate edges.</p>}
        <div className="collision-inspector-pagination">
          <button type="button" className="secondary" disabled={loading || page.page.previousOffset === null} onClick={() => setOffset(page.page.previousOffset ?? 0)}>Previous contenders</button>
          <button type="button" className="secondary" disabled={loading || page.page.nextOffset === null} onClick={() => setOffset(page.page.nextOffset ?? offset)}>Next contenders</button>
        </div>
      </>}
    </section>}
  </div>;
}
