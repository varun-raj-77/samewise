import {
  MappingSuggestionResponseSchema,
  BatchIdentityDecisionResponseSchema,
  RECONCILIATION_EXPORT_VERSION,
  RUN_MANIFEST_VERSION,
  RunSummarySchema,
  TRUSTED_EXPORT_VERSION,
  type ManualMapping,
  type MappingSuggestionResponse,
  type SemanticMappingProposal,
  type RunSummary,
} from "@samewise/contracts";
import { useEffect, useRef, useState } from "react";

import { ReviewWorkspace } from "./ReviewWorkspace.js";
import { ResultsWorkspace } from "./ResultsWorkspace.js";
import { SurvivorshipWorkspace } from "./SurvivorshipWorkspace.js";
import { EvaluationWorkspace } from "./EvaluationWorkspace.js";
import "./survivorship-workspace.css";

type Screen = "upload" | "profile" | "mapping" | "results" | "review" | "resolution" | "export" | "evaluation";
const STEPS: { id: Screen; label: string; screens: Screen[] }[] = [
  { id: "upload", label: "Upload", screens: ["upload", "profile"] },
  { id: "mapping", label: "Match setup", screens: ["mapping"] },
  { id: "review", label: "Review matches", screens: ["results", "review"] },
  { id: "resolution", label: "Merge values", screens: ["resolution"] },
  { id: "export", label: "Export", screens: ["export"] },
];

interface AppProps { initialRun?: RunSummary; initialScreen?: Screen }

async function parseRun(response: Response): Promise<RunSummary> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message ?? "Samewise could not complete that request.");
  }
  return RunSummarySchema.parse(await response.json());
}

async function parseSuggestionResponse(response: Response): Promise<MappingSuggestionResponse> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message ?? "AI suggestions unavailable. You can continue mapping columns manually.");
  }
  return MappingSuggestionResponseSchema.parse(await response.json());
}

export function App({ initialRun, initialScreen }: AppProps = {}) {
  const [run, setRun] = useState<RunSummary | null>(initialRun ? RunSummarySchema.parse(initialRun) : null);
  const [screen, setScreen] = useState<Screen>(() => {
    if (initialScreen) return initialScreen;
    const requested = new URLSearchParams(window.location.search).get("screen");
    return requested === "evaluation" || ["upload", "profile", "mapping", "results", "review", "resolution", "export"].includes(requested ?? "") ? requested as Screen : "upload";
  });
  const [fileA, setFileA] = useState<File | null>(null);
  const [fileB, setFileB] = useState<File | null>(null);
  const [draftMappings, setDraftMappings] = useState<ManualMapping[]>(initialRun?.mappings ?? []);
  const [mappingProposal, setMappingProposal] = useState<SemanticMappingProposal | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionNotice, setSuggestionNotice] = useState<string | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(!initialRun);
  const [error, setError] = useState<string | null>(null);
  const [confirmNewRun, setConfirmNewRun] = useState(false);
  const newRunButton = useRef<HTMLButtonElement>(null);
  const newRunDialog = useRef<HTMLDialogElement>(null);
  const cancelNewRunButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (initialRun) return;
    let active = true;
    const runId = new URLSearchParams(window.location.search).get("run");
    const request = runId ? fetch(`/api/runs/${encodeURIComponent(runId)}`) : fetch("/api/runs", { method: "POST" });
    void request.then(parseRun)
      .then((loaded) => {
        if (!active) return;
        setRun(loaded);
        setDraftMappings(loaded.mappings);
        if (!new URLSearchParams(window.location.search).get("screen")) setScreen(loaded.stage);
      })
      .catch(() => { if (active) setError(runId ? "This run is no longer available in the live API process. Start a new run to continue." : "The API is unavailable. Start the Samewise API and try again."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [initialRun]);

  useEffect(() => {
    if (!run || initialRun) return;
    const url = new URL(window.location.href);
    url.searchParams.set("run", run.runId);
    url.searchParams.set("screen", screen);
    window.history.replaceState(null, "", url);
  }, [initialRun, run, screen]);

  useEffect(() => {
    if (!confirmNewRun || !newRunDialog.current) return;
    if (!newRunDialog.current.open) {
      if (typeof newRunDialog.current.showModal === "function") newRunDialog.current.showModal();
      else newRunDialog.current.setAttribute("open", "");
    }
    cancelNewRunButton.current?.focus();
  }, [confirmNewRun]);

  async function action(work: () => Promise<RunSummary>, next?: Screen) {
    setBusy(true); setError(null);
    try {
      const updated = await work(); setRun(updated); if (next) setScreen(next); return updated;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Samewise could not complete that request."); return null;
    } finally { setBusy(false); }
  }

  async function upload() {
    if (!run || !fileA || !fileB) { setError("Choose one CSV file for Dataset A and one for Dataset B."); return; }
    if (![fileA, fileB].every((file) => file.name.toLowerCase().endsWith(".csv"))) { setError("Both source files must be CSV files."); return; }
    await action(async () => {
      const first = await parseRun(await fetch(`/api/runs/${run.runId}/datasets/A`, { method: "POST", headers: { "Content-Type": "text/csv", "X-File-Name": encodeURIComponent(fileA.name) }, body: fileA }));
      return parseRun(await fetch(`/api/runs/${first.runId}/datasets/B`, { method: "POST", headers: { "Content-Type": "text/csv", "X-File-Name": encodeURIComponent(fileB.name) }, body: fileB }));
    }, "profile");
  }

  function requestNewReconciliation() {
    if (run && hasMeaningfulWork(run)) setConfirmNewRun(true);
    else void startNewReconciliation();
  }

  function cancelNewReconciliation() {
    setConfirmNewRun(false);
    queueMicrotask(() => newRunButton.current?.focus());
  }

  async function startNewReconciliation() {
    setConfirmNewRun(false); setBusy(true); setError(null);
    try {
      const freshRun = await parseRun(await fetch("/api/runs", { method: "POST" }));
      setRun(freshRun); setFileA(null); setFileB(null); setDraftMappings([]);
      setMappingProposal(null); setSuggestionNotice(null); setSelectedCandidateId(null);
      setScreen("upload");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "A new reconciliation could not be created.");
    } finally { setBusy(false); }
  }

  function addMapping() {
    if (!run?.datasets.A || !run.datasets.B) return;
    const aColumn = run.datasets.A.columns.find((column) => !draftMappings.some((mapping) => mapping.aColumn === column.name))?.name ?? run.datasets.A.columns[0]?.name;
    const bColumn = run.datasets.B.columns.find((column) => !draftMappings.some((mapping) => mapping.bColumn === column.name))?.name ?? run.datasets.B.columns[0]?.name;
    if (!aColumn || !bColumn) return;
    setDraftMappings([...draftMappings, { mappingId: `mapping-${crypto.randomUUID()}`, label: aColumn.replaceAll("_", " "), aColumn, bColumn, useForMatching: true, includeInMerge: true, normalizer: "text", semanticFamily: "unknown" }]);
  }

  async function requestSuggestions() {
    if (!run) return;
    setSuggestionsLoading(true); setSuggestionNotice(null);
    try {
      const response = await parseSuggestionResponse(await fetch(`/api/runs/${run.runId}/mapping-suggestions`, { method: "POST" }));
      setMappingProposal(response.proposal);
      setDraftMappings(response.confirmedMappings);
    } catch (caught) {
      setSuggestionNotice(caught instanceof Error ? caught.message : "AI suggestions unavailable. You can continue mapping columns manually.");
    } finally { setSuggestionsLoading(false); }
  }

  async function useRecommendedSetup() {
    if (!run || !mappingProposal) return;
    setSuggestionsLoading(true); setSuggestionNotice(null);
    try {
      let latest: MappingSuggestionResponse | null = null;
      for (const suggestion of mappingProposal.suggestions.filter((item) => item.status === "pending")) {
        latest = await parseSuggestionResponse(await fetch(`/api/runs/${run.runId}/mapping-suggestions/${suggestion.suggestionId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "accept" }),
        }));
        setMappingProposal(latest.proposal);
        setDraftMappings(latest.confirmedMappings);
      }
      setSuggestionNotice("Recommended setup added. Inspect or adjust it before running matching.");
    } catch (caught) {
      setSuggestionNotice(caught instanceof Error ? caught.message : "The recommended setup could not be applied. Manual setup remains available.");
    } finally { setSuggestionsLoading(false); }
  }

  async function saveAndRun() {
    if (!run) return;
    if (!draftMappings.some((mapping) => mapping.useForMatching)) { setError("Choose at least one field Samewise can use to look for the same record."); return; }
    await action(async () => {
      const mapped = await parseRun(await fetch(`/api/runs/${run.runId}/mappings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mappings: draftMappings }) }));
      return parseRun(await fetch(`/api/runs/${mapped.runId}/match`, { method: "POST" }));
    }, "results");
  }

  function review(candidateId: string) { setSelectedCandidateId(candidateId); setScreen("review"); }
  async function decide(candidateId: string, decision: "same_entity" | "different_entity") {
    if (!run) return null;
    return action(() => fetch(`/api/runs/${run.runId}/candidates/${candidateId}/decisions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) }).then(parseRun));
  }
  async function setDeferred(aRowId: string, deferred: boolean) {
    if (!run) return null;
    return action(() => fetch(`/api/runs/${run.runId}/review-items/${encodeURIComponent(aRowId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deferred }) }).then(parseRun));
  }
  async function undoReview() {
    if (!run) return null;
    return action(() => fetch(`/api/runs/${run.runId}/review-undo`, { method: "POST" }).then(parseRun));
  }
  async function batchDecide(groupId: string, decision: "same_entity" | "different_entity") {
    if (!run) return null;
    return action(async () => {
      const response = await fetch(`/api/runs/${run.runId}/review-groups/${encodeURIComponent(groupId)}/decisions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, confirmed: true }) });
      if (!response.ok) { const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(payload?.error?.message ?? "The batch decision could not be applied."); }
      return BatchIdentityDecisionResponseSchema.parse(await response.json()).run;
    });
  }
  async function downloadExport(kind: "reconciliation" | "trusted" | "manifest") {
    if (!run) return;
    setBusy(true); setError(null);
    try {
      const endpoint = kind === "trusted" ? "trusted-export" : kind === "manifest" ? "manifest" : "export";
      const response = await fetch(`/api/runs/${run.runId}/${endpoint}`);
      if (!response.ok) { const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(payload?.error?.message ?? "Export could not be created."); }
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a");
      const fallback = kind === "trusted" ? `samewise-${run.runId}-trusted-merged.csv` : kind === "manifest" ? `samewise-${run.runId}-manifest.json` : `samewise-${run.runId}-reconciliation.csv`;
      const headerFilename = /filename="([A-Za-z0-9._-]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1];
      link.href = url; link.download = headerFilename ?? fallback; link.click(); URL.revokeObjectURL(url);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Export could not be created."); }
    finally { setBusy(false); }
  }

  return <div className="app-shell">
    <aside className="app-sidebar">
      <div className="brand"><span className="mark">S</span><strong>Samewise</strong></div>
      <nav className="app-navigation" aria-label="Samewise navigation">
        <div className="product-nav">
          <button aria-current={screen !== "evaluation" ? "page" : undefined} onClick={() => setScreen(run?.stage ?? "upload")}><span aria-hidden="true">R</span>Reconciliation</button>
          <button ref={newRunButton} className="new-reconciliation" onClick={requestNewReconciliation} disabled={busy}><span aria-hidden="true">+</span>New reconciliation</button>
          <details className="advanced-nav"><summary>Advanced</summary><button aria-current={screen === "evaluation" ? "page" : undefined} onClick={() => setScreen("evaluation")}><span aria-hidden="true">Q</span>Matching quality</button></details>
        </div>
        {screen !== "evaluation" && <div className="run-navigation"><p>Your reconciliation</p><ol>{STEPS.map((step, index) => { const currentIndex = Math.max(0, STEPS.findIndex((item) => item.screens.includes(screen))); const reviewComplete = Boolean(run?.summary && run.reviewProgress.remaining === 0 && run.reviewProgress.deferred === 0); const mergeComplete = reviewComplete && Boolean(run?.trustedExportReadiness.ready); const state = step.id === "review" && reviewComplete ? "complete" : step.id === "resolution" && mergeComplete ? "complete" : step.id === "resolution" && !reviewComplete ? "upcoming" : step.id === "resolution" && reviewComplete && screen !== "resolution" ? "next" : step.id === "export" && !mergeComplete ? "upcoming" : step.id === "export" && mergeComplete && screen !== "export" ? "next" : step.screens.includes(screen) ? "active" : index < currentIndex ? "complete" : "upcoming"; return <li key={step.id} className={state} aria-current={step.screens.includes(screen) ? "step" : undefined}><span aria-hidden="true">{state === "complete" ? "✓" : index + 1}</span>{step.label}</li>; })}</ol></div>}
      </nav>
    </aside>
    <main className={screen === "evaluation" ? "workspace evaluation-layout" : "workspace"}>
      <section className={screen === "review" ? "content review-content" : "content"}>
        {error && <div className="error-banner" role="alert">{error}</div>}{busy && <div className="busy" aria-live="polite">Working…</div>}
        {screen === "upload" && <section className="upload-screen" aria-labelledby="upload-title"><header className="page-heading"><h1 id="upload-title">Upload datasets</h1><p>Connect two sources that may describe the same entities.</p></header>{run && (run.datasets.A || run.datasets.B) ? <section className="locked-sources" aria-labelledby="locked-sources-title"><h2 id="locked-sources-title">Source files are locked for this run</h2><p>Uploaded sources remain immutable. Start a new reconciliation to use different files; this run will remain unchanged.</p><button className="primary" onClick={requestNewReconciliation}>New reconciliation</button></section> : <section className="source-pair-panel" aria-label="Source pair"><header><div><span className="panel-kicker">Source pair</span><h2>Choose the datasets to reconcile</h2></div><span className="panel-meta">2 CSV files</span></header><div className="source-pair"><FilePicker key={`${run?.runId ?? "new"}-A`} side="A" file={fileA} onChange={setFileA} /><div className="pair-relationship" aria-hidden="true"><span>→</span><small>paired with</small></div><FilePicker key={`${run?.runId ?? "new"}-B`} side="B" file={fileB} onChange={setFileB} /></div><footer><p><strong>Original files remain unchanged.</strong><span>CSV · up to 2 MiB each</span></p><button className="primary" onClick={() => void upload()} disabled={busy}>Upload & profile <span aria-hidden="true">→</span></button></footer></section>}</section>}
        {screen === "profile" && run?.datasets.A && run.datasets.B && <section aria-labelledby="profile-title"><p className="eyebrow">File details</p><h1 id="profile-title">Your files are ready.</h1><p className="lede">Review the bounded file profile, then set up how corresponding fields should be used.</p><div className="profile-grid"><ProfileCard profile={run.datasets.A} /><ProfileCard profile={run.datasets.B} /></div><button className="primary" onClick={() => setScreen("mapping")}>Set up matching</button></section>}
        {screen === "mapping" && run?.datasets.A && run.datasets.B && <section aria-labelledby="mapping-title">
          <p className="eyebrow">Step 2 · Match setup</p>
          <h1 id="mapping-title">Set up matching.</h1>
          <p className="lede">Choose which corresponding fields help find the same record and which business values belong in the reconciled result. A field can do both.</p>
          <div className="ai-mapping-panel">
            <header><div><small>Optional assistant</small><h2>{mappingProposal ? `Samewise found ${mappingProposal.suggestions.length} corresponding fields.` : "Find corresponding fields"}</h2></div><button className="secondary" onClick={() => void requestSuggestions()} disabled={suggestionsLoading}>{mappingProposal ? "Refresh recommendations" : "Get recommended setup"}</button></header>
            {suggestionsLoading && <p className="ai-loading" aria-live="polite">Reviewing schema metadata…</p>}
            {suggestionNotice && <div className="mapping-notice" role="status">{suggestionNotice}</div>}
            {mappingProposal && <>
              <p className="proposal-note">Recommendations use bounded profile metadata only. They do not inspect rows or decide identity.</p>
              <div className="setup-table-wrap"><table className="setup-table"><thead><tr><th>Field correspondence</th><th>Use to match</th><th>Keep in result</th><th>Recommendation</th></tr></thead><tbody>{mappingProposal.suggestions.map((suggestion) => <tr key={suggestion.suggestionId}><td><strong>{suggestion.leftColumn}</strong><span> ↔ </span><strong>{suggestion.rightColumn}</strong><small>{suggestion.reason}</small></td><td>{suggestion.useForMatching ? "✓" : "—"}</td><td>{suggestion.includeInMerge ? "✓" : "—"}</td><td>{suggestion.sourceSpecific ? "Source-specific / metadata" : suggestion.relation.replaceAll("_", " ")}</td></tr>)}</tbody></table></div>
              {mappingProposal.suggestions.some((item) => item.status === "pending") && <button className="primary recommended-setup" onClick={() => void useRecommendedSetup()} disabled={suggestionsLoading}>Use recommended setup</button>}
              <p className="proposal-note">Model {mappingProposal.provenance.model} · {mappingProposal.provenance.promptVersion}. Recommendations stay inactive until you confirm them.</p>
            </>}
          </div>
          <details className="advanced-setup" open={!mappingProposal}>
            <summary>Advanced setup</summary>
            <p>Pair columns manually, override recommendations, or continue here when AI is unavailable.</p>
            <div className="mapping-list">{draftMappings.map((mapping, index) => <MappingRow key={mapping.mappingId} mapping={mapping} aColumns={run.datasets.A!.columns.map((column) => column.name)} bColumns={run.datasets.B!.columns.map((column) => column.name)} onChange={(next) => setDraftMappings(draftMappings.map((item, itemIndex) => itemIndex === index ? next : item))} onRemove={() => setDraftMappings(draftMappings.filter((_, itemIndex) => itemIndex !== index))} />)}</div>
            <button className="secondary" onClick={addMapping}>+ Add manual mapping</button>
          </details>
          <MatchingSafetyGuidance mappings={draftMappings} run={run} />
          <div className="actions"><button className="primary" onClick={() => void saveAndRun()} disabled={busy || suggestionsLoading || !draftMappings.some((mapping) => mapping.useForMatching)}>Confirm setup & run matching</button></div>
        </section>}
        {screen === "results" && run?.summary && <ResultsWorkspace run={run} onReview={review} onResolution={() => setScreen("resolution")} onOpenReview={() => setScreen("review")} onExport={() => setScreen("export")} />}
        {screen === "review" && run && <ReviewWorkspace run={run} initialCandidateId={selectedCandidateId} busy={busy} onDecision={decide} onBatchDecision={batchDecide} onDefer={setDeferred} onUndo={undoReview} onGoResolution={() => setScreen("resolution")} />}
        {screen === "resolution" && run && <SurvivorshipWorkspace run={run} busy={busy} onRun={setRun} onBusy={setBusy} onError={setError} onReview={() => setScreen("review")} onBack={() => setScreen("results")} onContinue={() => setScreen("export")} />}
        {screen === "export" && run?.summary && <ExportWorkspace run={run} busy={busy} onDownload={downloadExport} onResults={() => setScreen("results")} onReview={() => setScreen("review")} onResolution={() => setScreen("resolution")} />}
        {screen === "evaluation" && <EvaluationWorkspace runId={run?.runId ?? null} onBack={() => setScreen(run?.summary ? "results" : run?.stage ?? "upload")} />}
      </section>
    </main>
    {confirmNewRun && <dialog ref={newRunDialog} className="new-run-dialog" aria-modal="true" aria-labelledby="new-run-title" aria-describedby="new-run-description" onCancel={(event) => { event.preventDefault(); cancelNewReconciliation(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelNewReconciliation(); } }}>
      <h2 id="new-run-title">Start a new reconciliation?</h2>
      <p id="new-run-description">Your current run will remain unchanged.</p>
      <div className="dialog-actions"><button ref={cancelNewRunButton} className="secondary" onClick={cancelNewReconciliation}>Cancel</button><button className="primary" onClick={() => void startNewReconciliation()} disabled={busy}>Start new reconciliation</button></div>
    </dialog>}
  </div>;
}

function ExportWorkspace({ run, busy, onDownload, onResults, onReview, onResolution }: {
  run: RunSummary;
  busy: boolean;
  onDownload: (kind: "reconciliation" | "trusted" | "manifest") => Promise<void>;
  onResults: () => void;
  onReview: () => void;
  onResolution: () => void;
}) {
  const comparisonCount = run.mappings.filter((mapping) => mapping.includeInMerge).length;
  const unresolvedIdentity = run.trustedExportReadiness.unresolvedIdentityCount;
  const readiness = unresolvedIdentity > 0
    ? { tone: "blocked", title: "Identity review isn't finished", detail: `${unresolvedIdentity} identity decision${unresolvedIdentity === 1 ? "" : "s"} must be resolved before trusted output is ready.` }
    : comparisonCount === 0
      ? { tone: "informational", title: "Identity resolved · no merge fields configured", detail: "Reconciled output is ready for resolved identity and unmatched records, but it contains no merged business fields." }
      : run.trustedExportReadiness.unresolvedConflictCount > 0
        ? { tone: "blocked", title: "Field conflicts still need resolution", detail: `${run.trustedExportReadiness.unresolvedConflictCount} comparison-field conflict${run.trustedExportReadiness.unresolvedConflictCount === 1 ? "" : "s"} must be resolved before trusted output is ready.` }
        : { tone: "ready", title: "Ready to export", detail: "Identity is resolved and every surfaced merge-value difference has an explicit outcome." };
  const trustedLabel = run.trustedExportReadiness.ready ? (comparisonCount === 0 ? "Ready · identity only" : "Ready") : "Blocked";

  return <section aria-labelledby="export-title">
    <p className="eyebrow">Step 5 · Export</p><h1 id="export-title">Download reconciled data.</h1>
    <p className="lede">Ready to export means every surfaced reconciliation decision has an explicit outcome. It does not guarantee that every possible real-world match was found.</p>
    <section className={`readiness-status ${readiness.tone}`} role="note" aria-labelledby="readiness-title"><div><small>Current readiness</small><h2 id="readiness-title">{readiness.title}</h2></div><p>{readiness.detail}</p></section>
    <div className="export-run-context"><span><small>Run</small><code>{run.runId}</code></span><span><small>Dataset A</small><code>{run.datasets.A?.sha256.slice(0, 12)}…</code></span><span><small>Dataset B</small><code>{run.datasets.B?.sha256.slice(0, 12)}…</code></span></div>
    <div className="export-artifact-list">
      <article className="export-artifact primary-export"><div><small>Reconciled data</small><strong>{trustedLabel}</strong><code>{TRUSTED_EXPORT_VERSION}</code><p>{run.trustedExportReadiness.eligibleConfirmedCount} matched {run.trustedExportReadiness.eligibleConfirmedCount === 1 ? "entity" : "entities"} · {run.conflictSummary.humanIdentityDecisions ?? run.reviewProgress.reviewed} human identity {(run.conflictSummary.humanIdentityDecisions ?? run.reviewProgress.reviewed) === 1 ? "decision" : "decisions"} · {run.conflictSummary.resolved - (run.conflictSummary.manualDecisions ?? 0)} {run.conflictSummary.resolved - (run.conflictSummary.manualDecisions ?? 0) === 1 ? "difference" : "differences"} handled by rules · {run.conflictSummary.manualDecisions ?? 0} manual value {(run.conflictSummary.manualDecisions ?? 0) === 1 ? "decision" : "decisions"} · {run.conflictSummary.unresolved} unfinished decisions.</p>{(run.conflictSummary.preservedBoth ?? 0) > 0 && <p>Some fields intentionally preserve both source values.</p>}</div><button className="primary" onClick={() => void onDownload("trusted")} disabled={busy || !run.trustedExportReadiness.ready}>Download reconciled data</button></article>
      <details className="audit-files"><summary>Audit & technical files</summary><article className="export-artifact"><div><small>Reconciliation report</small><strong>Available</strong><code>{RECONCILIATION_EXPORT_VERSION}</code><p>Includes automatic and human match outcomes, deferred work, unmatched records, and resolution state.</p></div><button className="secondary" onClick={() => void onDownload("reconciliation")} disabled={busy}>Download reconciliation report</button></article><article className="export-artifact"><div><small>Provenance manifest</small><strong>Available</strong><code>{RUN_MANIFEST_VERSION}</code><p>Records source fingerprints, mapping and matcher versions, decisions, policies, and hashes.</p></div><button className="secondary" onClick={() => void onDownload("manifest")} disabled={busy}>Download provenance manifest</button></article></details>
    </div>
    {!run.trustedExportReadiness.ready && <div className="warning" role="status"><strong>Trusted export blocked.</strong><ul>{run.trustedExportReadiness.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
    <div className="actions">{unresolvedIdentity > 0 ? <button className="secondary" onClick={onReview}>Review identity</button> : run.trustedExportReadiness.unresolvedConflictCount > 0 ? <button className="secondary" onClick={onResolution}>Review unresolved conflicts</button> : <button className="secondary" onClick={onResults}>Back to results</button>}</div>
  </section>;
}

function hasMeaningfulWork(run: RunSummary): boolean {
  return Boolean(run.datasets.A || run.datasets.B || run.mappings.length || run.summary || run.reviewProgress.reviewed || run.reviewProgress.deferred || run.conflictSummary.total);
}

function FilePicker({ side, file, onChange }: { side: "A" | "B"; file: File | null; onChange: (file: File | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className={`file-picker${file ? " has-file" : ""}`}>
    <div className="file-picker-heading"><span className="dataset-badge">{side}</span><strong>Dataset {side}</strong><small>{file ? "Selected" : "CSV required"}</small></div>
    {file ? <div className="selected-file-panel"><strong className="selected-file">{file.name}</strong><div><button type="button" className="file-action" aria-label={`Replace Dataset ${side} CSV`} onClick={() => input.current?.click()}>Replace</button><button type="button" className="file-action remove" aria-label={`Remove Dataset ${side} CSV`} onClick={() => { if (input.current) input.current.value = ""; onChange(null); }}>Remove</button></div></div> : <label className="drop-target" htmlFor={`dataset-${side}-file`}><strong>Drop CSV here</strong><small>or <span className="browse-affordance">browse files</span></small></label>}
    <input ref={input} id={`dataset-${side}-file`} aria-label={`Dataset ${side} CSV`} type="file" accept=".csv,text/csv" onChange={(event) => onChange(event.target.files?.[0] ?? null)} />
  </div>;
}
function ProfileCard({ profile }: { profile: NonNullable<RunSummary["datasets"]["A"]> }) { return <article className="profile-card"><header><span className="dataset-badge">{profile.side}</span><div><h2>{profile.originalFilename}</h2><small>{profile.rowCount} rows · SHA-256 {profile.sha256.slice(0, 10)}…</small></div></header><div className="profile-columns">{profile.columns.map((column) => <div key={column.name}><strong>{column.name}</strong><span>{column.inferredType}</span><small>{column.nullCount} null · {column.distinctCount} distinct</small><p>{column.samples.join(" · ") || "No sample"}</p></div>)}</div></article>; }
function MappingRow({ mapping, aColumns, bColumns, onChange, onRemove }: { mapping: ManualMapping; aColumns: string[]; bColumns: string[]; onChange: (mapping: ManualMapping) => void; onRemove: () => void }) { return <div className="mapping-row"><input aria-label="Mapping label" value={mapping.label} onChange={(event) => onChange({ ...mapping, label: event.target.value })} /><select aria-label="Dataset A column" value={mapping.aColumn} onChange={(event) => onChange({ ...mapping, aColumn: event.target.value })}>{aColumns.map((column) => <option key={column}>{column}</option>)}</select><span>↔</span><select aria-label="Dataset B column" value={mapping.bColumn} onChange={(event) => onChange({ ...mapping, bColumn: event.target.value })}>{bColumns.map((column) => <option key={column}>{column}</option>)}</select><label className="mapping-check"><input type="checkbox" checked={mapping.useForMatching} onChange={(event) => onChange({ ...mapping, useForMatching: event.target.checked })} />Use to match</label><label className="mapping-check"><input type="checkbox" checked={mapping.includeInMerge} onChange={(event) => onChange({ ...mapping, includeInMerge: event.target.checked })} />Keep in result</label><select aria-label="Field type" value={mapping.semanticFamily ?? "unknown"} onChange={(event) => onChange({ ...mapping, semanticFamily: event.target.value as NonNullable<ManualMapping["semanticFamily"]> })}><option value="unknown">Unknown</option><option value="persistent_identifier">Persistent ID</option><option value="source_local_identifier">Source-local ID</option><option value="name_or_title">Entity name / title</option><option value="contact_person">Contact person</option><option value="email">Email</option><option value="phone">Phone</option><option value="domain">Website / domain</option><option value="address">Address</option><option value="geography">Geography</option><option value="categorical">Category</option><option value="numeric">Numeric</option><option value="date_or_timestamp">Date / timestamp</option><option value="free_text">Free text</option></select><select aria-label="Normalizer" value={mapping.normalizer} onChange={(event) => onChange({ ...mapping, normalizer: event.target.value as ManualMapping["normalizer"] })}><option value="text">Text</option><option value="phone">Phone</option><option value="email">Email</option><option value="number">Number</option><option value="date">Date</option></select><button className="icon-button" aria-label={`Remove ${mapping.label}`} onClick={onRemove}>×</button></div>; }

function MatchingSafetyGuidance({ mappings, run }: { mappings: ManualMapping[]; run: RunSummary }) {
  const matching = mappings.filter((mapping) => mapping.useForMatching);
  const warnings: string[] = [];
  if (matching.length === 0) warnings.push("Choose at least one field Samewise can use to look for the same record.");
  if (matching.length === 1 && matching[0]?.semanticFamily === "name_or_title") warnings.push("Name alone is weak evidence. Different people or companies can share the same name. Samewise will not treat name alone as sufficient for an automatic match.");
  else if (matching.length === 1) warnings.push("Only one matching signal is selected. Missing or conflicting values may leave records unmatched or send them to review.");
  const weakFamilies = new Set(["source_local_identifier", "contact_person", "geography", "categorical", "free_text", "unknown"]);
  if (matching.length > 0 && matching.every((mapping) => weakFamilies.has(mapping.semanticFamily ?? "unknown"))) warnings.push("Matching evidence is weak. Different entities may share these values. Samewise will avoid unsafe automatic matches and may leave more records unmatched or requiring review.");
  const duplicateSignal = matching.some((mapping) => {
    if (mapping.semanticFamily !== "persistent_identifier") return false;
    const a = run.datasets.A?.columns.find((column) => column.name === mapping.aColumn);
    const b = run.datasets.B?.columns.find((column) => column.name === mapping.bColumn);
    return Boolean((a && (a.normalizedDistinctCount ?? a.distinctCount) < run.datasets.A!.rowCount - a.nullCount) || (b && (b.normalizedDistinctCount ?? b.distinctCount) < run.datasets.B!.rowCount - b.nullCount));
  });
  if (duplicateSignal) warnings.push("Possible duplicate entities exist within this source. Competing matches will be routed to review.");
  for (const mapping of matching) {
    const a = run.datasets.A?.columns.find((column) => column.name === mapping.aColumn);
    const b = run.datasets.B?.columns.find((column) => column.name === mapping.bColumn);
    if ((a?.nullCount ?? 0) > 0 || (b?.nullCount ?? 0) > 0) warnings.push(`${mapping.label} is missing in some ${[(a?.nullCount ?? 0) > 0 ? "Dataset A" : "", (b?.nullCount ?? 0) > 0 ? "Dataset B" : ""].filter(Boolean).join(" and ")} records. Consider adding another matching field.`);
    if (mapping.semanticFamily === "source_local_identifier") warnings.push(`${mapping.label} is marked as a source-local identifier. Such fields are excluded by default because row IDs often differ between systems; this override remains auditable.`);
    if (["contact_person", "geography", "categorical", "free_text", "unknown"].includes(mapping.semanticFamily ?? "unknown") && (a?.mostCommonValueRate ?? 0) >= 0.05 && (b?.mostCommonValueRate ?? 0) >= 0.05) warnings.push(`${mapping.label} contains repeated supporting values. It can help with context but should not be the only reason to review a pair.`);
  }
  return warnings.length ? <aside className="mapping-safety" aria-label="Matching setup guidance"><strong>{matching.length === 0 ? "Matching cannot start yet" : "Check this setup"}</strong><ul>{[...new Set(warnings)].map((warning) => <li key={warning}>{warning}</li>)}</ul></aside> : null;
}
