import {
  MappingSuggestionResponseSchema,
  RunViewSchema,
  type ManualMapping,
  type MappingSuggestionResponse,
  type SemanticMappingProposal,
  type RunView,
} from "@samewise/contracts";
import { useEffect, useState } from "react";

import { ReviewWorkspace } from "./ReviewWorkspace.js";
import { SurvivorshipWorkspace } from "./SurvivorshipWorkspace.js";
import { EvaluationWorkspace } from "./EvaluationWorkspace.js";
import "./survivorship-workspace.css";

type Screen = "upload" | "profile" | "mapping" | "results" | "review" | "resolution" | "export" | "evaluation";
const STEPS: { id: Screen; label: string }[] = [
  { id: "upload", label: "Upload" }, { id: "profile", label: "Profile" },
  { id: "mapping", label: "Map fields" }, { id: "results", label: "Results" },
  { id: "review", label: "Review identity" }, { id: "resolution", label: "Resolve fields" },
  { id: "export", label: "Export" },
];

interface AppProps { initialRun?: RunView; initialScreen?: Screen }

async function parseRun(response: Response): Promise<RunView> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message ?? "Samewise could not complete that request.");
  }
  return RunViewSchema.parse(await response.json());
}

async function parseSuggestionResponse(response: Response): Promise<MappingSuggestionResponse> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message ?? "AI suggestions unavailable. You can continue mapping columns manually.");
  }
  return MappingSuggestionResponseSchema.parse(await response.json());
}

export function App({ initialRun, initialScreen }: AppProps = {}) {
  const [run, setRun] = useState<RunView | null>(initialRun ? RunViewSchema.parse(initialRun) : null);
  const [screen, setScreen] = useState<Screen>(() => {
    if (initialScreen) return initialScreen;
    const requested = new URLSearchParams(window.location.search).get("screen");
    return requested === "evaluation" || STEPS.some((step) => step.id === requested) ? requested as Screen : "upload";
  });
  const [fileA, setFileA] = useState<File | null>(null);
  const [fileB, setFileB] = useState<File | null>(null);
  const [draftMappings, setDraftMappings] = useState<ManualMapping[]>(initialRun?.mappings ?? []);
  const [mappingProposal, setMappingProposal] = useState<SemanticMappingProposal | null>(null);
  const [suggestionEdits, setSuggestionEdits] = useState<Record<string, { bColumn: string; role: ManualMapping["role"] }>>({});
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionNotice, setSuggestionNotice] = useState<string | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(!initialRun);
  const [error, setError] = useState<string | null>(null);

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

  const unresolved = run?.conflicts.filter((conflict) => !conflict.resolution) ?? [];
  const pendingReview = run?.reviewQueue.filter((item) => item.state === "needs_review") ?? [];

  async function action(work: () => Promise<RunView>, next?: Screen) {
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

  function addMapping() {
    if (!run?.datasets.A || !run.datasets.B) return;
    const aColumn = run.datasets.A.columns.find((column) => !draftMappings.some((mapping) => mapping.aColumn === column.name))?.name ?? run.datasets.A.columns[0]?.name;
    const bColumn = run.datasets.B.columns.find((column) => !draftMappings.some((mapping) => mapping.bColumn === column.name))?.name ?? run.datasets.B.columns[0]?.name;
    if (!aColumn || !bColumn) return;
    setDraftMappings([...draftMappings, { mappingId: `mapping-${crypto.randomUUID()}`, label: aColumn.replaceAll("_", " "), aColumn, bColumn, role: "identity", normalizer: "text" }]);
  }

  async function requestSuggestions() {
    if (!run) return;
    setSuggestionsLoading(true); setSuggestionNotice(null);
    try {
      const response = await parseSuggestionResponse(await fetch(`/api/runs/${run.runId}/mapping-suggestions`, { method: "POST" }));
      setMappingProposal(response.proposal);
      setDraftMappings(response.confirmedMappings);
      setSuggestionEdits(Object.fromEntries(response.proposal.suggestions.map((suggestion) => [
        suggestion.suggestionId,
        { bColumn: suggestion.rightColumn, role: suggestion.role },
      ])));
    } catch (caught) {
      setSuggestionNotice(caught instanceof Error ? caught.message : "AI suggestions unavailable. You can continue mapping columns manually.");
    } finally { setSuggestionsLoading(false); }
  }

  async function reviewSuggestion(suggestionId: string, decision: "accept" | "reject" | "remap") {
    if (!run || !mappingProposal) return;
    const suggestion = mappingProposal.suggestions.find((item) => item.suggestionId === suggestionId);
    if (!suggestion) return;
    const edit = suggestionEdits[suggestionId] ?? { bColumn: suggestion.rightColumn, role: suggestion.role };
    const finalMapping = decision === "remap" ? {
      mappingId: `mapping-${crypto.randomUUID()}`,
      label: suggestion.leftColumn.replaceAll("_", " "),
      aColumn: suggestion.leftColumn,
      bColumn: edit.bColumn,
      role: edit.role,
      normalizer: suggestion.normalizationHints.includes("phone_digits") ? "phone" as const : "text" as const,
    } : undefined;
    setSuggestionsLoading(true); setSuggestionNotice(null);
    try {
      const response = await parseSuggestionResponse(await fetch(`/api/runs/${run.runId}/mapping-suggestions/${suggestionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, ...(finalMapping ? { finalMapping } : {}) }),
      }));
      setMappingProposal(response.proposal);
      setDraftMappings(response.confirmedMappings);
    } catch (caught) {
      setSuggestionNotice(caught instanceof Error ? caught.message : "That suggestion decision could not be saved. Manual mapping is still available.");
    } finally { setSuggestionsLoading(false); }
  }

  async function saveAndRun() {
    if (!run) return;
    if (!draftMappings.some((mapping) => mapping.role === "identity")) { setError("Add at least one identity-evidence mapping."); return; }
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
  async function downloadExport(kind: "reconciliation" | "trusted") {
    if (!run) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/runs/${run.runId}/${kind === "trusted" ? "trusted-export" : "export"}`);
      if (!response.ok) { const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null; throw new Error(payload?.error?.message ?? "Export could not be created."); }
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a");
      link.href = url; link.download = kind === "trusted" ? `samewise-trusted-${run.runId}.csv` : `samewise-${run.runId}.csv`; link.click(); URL.revokeObjectURL(url);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Export could not be created."); }
    finally { setBusy(false); }
  }

  return <main className="app-shell">
    <header className="topbar"><div><span className="mark">S</span><strong>Samewise</strong></div><div className="product-nav" aria-label="Product areas"><button aria-current={screen !== "evaluation" ? "page" : undefined} onClick={() => setScreen(run?.stage ?? "upload")}>Reconciliation</button><button aria-current={screen === "evaluation" ? "page" : undefined} onClick={() => setScreen("evaluation")}>Evaluation</button></div><p>Trusted reconciliation workspace</p></header>
    <div className={screen === "evaluation" ? "workspace evaluation-layout" : "workspace"}>
      {screen !== "evaluation" && <nav className="stepper" aria-label="Reconciliation progress"><p className="eyebrow">Reconciliation run</p><ol>{STEPS.map((step, index) => <li key={step.id} className={screen === step.id ? "active" : ""}><span>{index + 1}</span>{step.label}</li>)}</ol><div className="principle"><strong>Identity ≠ survivorship</strong><p>First confirm the entity. Then choose which conflicting values survive.</p></div></nav>}
      <section className={screen === "review" ? "content review-content" : "content"}>
        {error && <div className="error-banner" role="alert">{error}</div>}{busy && <div className="busy" aria-live="polite">Working…</div>}
        {screen === "upload" && <section aria-labelledby="upload-title"><p className="eyebrow">Step 1 · Immutable sources</p><h1 id="upload-title">Start with two messy CSV files.</h1><p className="lede">Samewise fingerprints and profiles each source without rewriting it.</p><div className="upload-grid"><FilePicker side="A" file={fileA} onChange={setFileA} /><FilePicker side="B" file={fileB} onChange={setFileB} /></div><button className="primary" onClick={() => void upload()} disabled={busy}>Upload & profile</button><p className="fine-print">CSV only · 2 MiB per file · source bytes remain unchanged</p></section>}
        {screen === "profile" && run?.datasets.A && run.datasets.B && <section aria-labelledby="profile-title"><p className="eyebrow">Step 2 · Source profile</p><h1 id="profile-title">Know what arrived.</h1><p className="lede">Profiles are derived in the matcher process. Samples are intentionally limited.</p><div className="profile-grid"><ProfileCard profile={run.datasets.A} /><ProfileCard profile={run.datasets.B} /></div><button className="primary" onClick={() => setScreen("mapping")}>Map corresponding fields</button></section>}
        {screen === "mapping" && run?.datasets.A && run.datasets.B && <section aria-labelledby="mapping-title"><p className="eyebrow">Step 3 · Human-confirmed mapping</p><h1 id="mapping-title">Review what corresponds.</h1><p className="lede">AI may propose schema mappings from metadata only. Nothing becomes active until you accept, reject, remap, or create it manually. Identity evidence affects matching; comparison fields are inspected only afterward.</p><div className="ai-mapping-panel"><header><div><small>Optional assistant</small><h2>Semantic mapping suggestions</h2></div><button className="secondary" onClick={() => void requestSuggestions()} disabled={suggestionsLoading}>{mappingProposal ? "Refresh suggestions" : "Request AI suggestions"}</button></header>{suggestionsLoading && <p className="ai-loading" aria-live="polite">Loading AI suggestions…</p>}{suggestionNotice && <div className="mapping-notice" role="status">{suggestionNotice}</div>}{mappingProposal && <><p className="proposal-note">Model {mappingProposal.provenance.model} · prompt {mappingProposal.provenance.promptVersion}. Confidence is advisory.</p><div className="suggestion-list">{mappingProposal.suggestions.map((suggestion) => { const edit = suggestionEdits[suggestion.suggestionId] ?? { bColumn: suggestion.rightColumn, role: suggestion.role }; return <article className={`suggestion-card ${suggestion.status}`} key={suggestion.suggestionId}><header><div className="suggestion-pair"><strong>{suggestion.leftColumn}</strong><span>↔</span><strong>{suggestion.rightColumn}</strong></div><span className="suggestion-status">{suggestion.status}</span></header><div className="suggestion-meta"><span>{suggestion.relation.replaceAll("_", " ")}</span><span>{suggestion.role === "identity" ? "Identity evidence" : "Post-identity comparison"}</span><span>Model confidence · {Math.round(suggestion.confidence * 100)}% (advisory)</span></div><p>{suggestion.reason}</p>{suggestion.status === "pending" ? <div className="suggestion-review"><label>Remap Dataset B<select aria-label={`Remap ${suggestion.leftColumn} Dataset B column`} value={edit.bColumn} onChange={(event) => setSuggestionEdits({ ...suggestionEdits, [suggestion.suggestionId]: { ...edit, bColumn: event.target.value } })}>{run.datasets.B!.columns.map((column) => <option key={column.name}>{column.name}</option>)}</select></label><label>Confirmed role<select aria-label={`Confirmed role for ${suggestion.leftColumn}`} value={edit.role} onChange={(event) => setSuggestionEdits({ ...suggestionEdits, [suggestion.suggestionId]: { ...edit, role: event.target.value as ManualMapping["role"] } })}><option value="identity">Identity evidence</option><option value="comparison">Post-identity comparison</option></select></label><div><button className="accept" onClick={() => void reviewSuggestion(suggestion.suggestionId, "accept")}>Accept</button><button className="reject" onClick={() => void reviewSuggestion(suggestion.suggestionId, "reject")}>Reject</button><button className="remap" onClick={() => void reviewSuggestion(suggestion.suggestionId, "remap")}>Remap</button></div></div> : suggestion.finalMapping && <p className="final-mapping">Confirmed: {suggestion.finalMapping.aColumn} ↔ {suggestion.finalMapping.bColumn} · {suggestion.finalMapping.role}</p>}</article>; })}</div>{(mappingProposal.unmappedLeft.length > 0 || mappingProposal.unmappedRight.length > 0) && <p className="unmapped-note">Left unmapped: {mappingProposal.unmappedLeft.join(", ") || "none"} · Right unmapped: {mappingProposal.unmappedRight.join(", ") || "none"}</p>}</>}</div><div className="manual-heading"><div><small>Manual fallback</small><h2>Confirmed mappings</h2></div><p>Add mappings the assistant missed, change any confirmed role, or continue entirely without AI.</p></div><div className="mapping-list">{draftMappings.map((mapping, index) => <MappingRow key={mapping.mappingId} mapping={mapping} aColumns={run.datasets.A!.columns.map((column) => column.name)} bColumns={run.datasets.B!.columns.map((column) => column.name)} onChange={(next) => setDraftMappings(draftMappings.map((item, itemIndex) => itemIndex === index ? next : item))} onRemove={() => setDraftMappings(draftMappings.filter((_, itemIndex) => itemIndex !== index))} />)}</div><div className="actions"><button className="secondary" onClick={addMapping}>+ Add manual mapping</button><button className="primary" onClick={() => void saveAndRun()} disabled={busy || suggestionsLoading}>Save confirmed mappings & run matcher</button></div></section>}
        {screen === "results" && run?.summary && <section aria-labelledby="results-title"><p className="eyebrow">Step 4 · Explainable matcher</p><h1 id="results-title">Evidence first, uncertainty visible.</h1><p className="lede">Match scores are deterministic evidence scores, not probabilities. Auto-matches remain system proposals; review and human confirmation stay distinct. Only B means no identity link is established, even when the row appears as an alternative.</p><div className="summary-grid"><Metric label="Matched" value={run.summary.matched} /><Metric label="Needs review" value={run.summary.needsReview} accent /><Metric label="Only A" value={run.summary.onlyA} /><Metric label="Only B" value={run.summary.onlyB} /></div><div className="result-list"><h2>Needs Review queue</h2>{pendingReview.length ? pendingReview.slice(0, 8).map((item) => <button className="candidate-row" key={item.aRowId} onClick={() => review(item.topCandidateId)}><span><strong>{item.aRowId}</strong> ↔ <strong>{item.topBRowId}</strong><small>{item.collision ? "Shared preferred candidate" : item.strongContradiction ? "Strong identifier conflict" : `${item.candidateCount} candidate${item.candidateCount === 1 ? "" : "s"} available`}</small></span><b>{item.topMatchScore.toFixed(3)}</b></button>) : <p className="empty">No active review items remain.</p>}</div><div className="actions"><button className="secondary" onClick={() => setScreen("resolution")}>View field conflicts ({unresolved.length})</button><button className="secondary" onClick={() => setScreen("review")} disabled={run.reviewProgress.total === 0}>Open review workspace</button><button className="primary" onClick={() => setScreen("export")}>Prepare export</button></div></section>}
        {screen === "review" && run && <ReviewWorkspace run={run} initialCandidateId={selectedCandidateId} busy={busy} onDecision={decide} onDefer={setDeferred} onUndo={undoReview} onGoResolution={() => setScreen("resolution")} />}
        {screen === "resolution" && run && <SurvivorshipWorkspace run={run} busy={busy} onRun={setRun} onBusy={setBusy} onError={setError} onBack={() => setScreen("results")} onContinue={() => setScreen("export")} />}
        {screen === "export" && run?.summary && <section aria-labelledby="export-title"><p className="eyebrow">Step 7 · Separate exports</p><h1 id="export-title">Report everything. Trust only what is ready.</h1><p className="lede">The reconciliation report always preserves uncertainty. Trusted merged output is gated until identity review and every relevant field conflict are resolved.</p><div className="export-card"><div><small>Reconciliation report</small><strong>Available</strong></div><div><small>Trusted output</small><strong>{run.trustedExportReadiness.ready ? "Ready" : "Blocked"}</strong></div><div><small>Formula safety</small><strong>Enabled</strong></div></div>{!run.trustedExportReadiness.ready && <div className="warning" role="status"><strong>Trusted export blocked.</strong> {run.trustedExportReadiness.blockers.join(" ")}</div>}<div className="actions"><button className="secondary" onClick={() => setScreen("resolution")}>Review conflicts</button><button className="secondary" onClick={() => void downloadExport("reconciliation")} disabled={busy}>Download reconciliation report</button><button className="primary" onClick={() => void downloadExport("trusted")} disabled={busy || !run.trustedExportReadiness.ready}>Download trusted merged output</button></div></section>}
        {screen === "evaluation" && <EvaluationWorkspace runId={run?.runId ?? null} onBack={() => setScreen(run?.summary ? "results" : run?.stage ?? "upload")} />}
      </section>
    </div>
  </main>;
}

function FilePicker({ side, file, onChange }: { side: "A" | "B"; file: File | null; onChange: (file: File | null) => void }) { return <label className="file-picker"><span className="dataset-badge">{side}</span><strong>Dataset {side}</strong><small>{file?.name ?? "Choose a CSV source"}</small><input aria-label={`Dataset ${side} CSV`} type="file" accept=".csv,text/csv" onChange={(event) => onChange(event.target.files?.[0] ?? null)} /></label>; }
function ProfileCard({ profile }: { profile: NonNullable<RunView["datasets"]["A"]> }) { return <article className="profile-card"><header><span className="dataset-badge">{profile.side}</span><div><h2>{profile.originalFilename}</h2><small>{profile.rowCount} rows · SHA-256 {profile.sha256.slice(0, 10)}…</small></div></header><div className="profile-columns">{profile.columns.map((column) => <div key={column.name}><strong>{column.name}</strong><span>{column.inferredType}</span><small>{column.nullCount} null · {column.distinctCount} distinct</small><p>{column.samples.join(" · ") || "No sample"}</p></div>)}</div></article>; }
function MappingRow({ mapping, aColumns, bColumns, onChange, onRemove }: { mapping: ManualMapping; aColumns: string[]; bColumns: string[]; onChange: (mapping: ManualMapping) => void; onRemove: () => void }) { return <div className={`mapping-row ${mapping.role}`}><input aria-label="Mapping label" value={mapping.label} onChange={(event) => onChange({ ...mapping, label: event.target.value })} /><select aria-label="Dataset A column" value={mapping.aColumn} onChange={(event) => onChange({ ...mapping, aColumn: event.target.value })}>{aColumns.map((column) => <option key={column}>{column}</option>)}</select><span>↔</span><select aria-label="Dataset B column" value={mapping.bColumn} onChange={(event) => onChange({ ...mapping, bColumn: event.target.value })}>{bColumns.map((column) => <option key={column}>{column}</option>)}</select><select aria-label="Mapping role" value={mapping.role} onChange={(event) => onChange({ ...mapping, role: event.target.value as ManualMapping["role"] })}><option value="identity">Identity evidence</option><option value="comparison">Post-identity comparison</option></select><select aria-label="Normalizer" value={mapping.normalizer} onChange={(event) => onChange({ ...mapping, normalizer: event.target.value as ManualMapping["normalizer"] })}><option value="text">Text</option><option value="phone">Phone</option><option value="email">Email</option><option value="number">Number</option><option value="date">Date</option></select><button className="icon-button" aria-label={`Remove ${mapping.label}`} onClick={onRemove}>×</button></div>; }
function Metric({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) { return <article className={accent ? "metric accent" : "metric"}><small>{label}</small><strong>{value}</strong></article>; }
