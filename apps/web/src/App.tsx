import { RunViewSchema, type CandidatePair, type ManualMapping, type RunView } from "@samewise/contracts";
import { useEffect, useMemo, useState } from "react";

type Screen = "upload" | "profile" | "mapping" | "results" | "review" | "resolution" | "export";
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

export function App({ initialRun, initialScreen }: AppProps = {}) {
  const [run, setRun] = useState<RunView | null>(initialRun ? RunViewSchema.parse(initialRun) : null);
  const [screen, setScreen] = useState<Screen>(initialScreen ?? "upload");
  const [fileA, setFileA] = useState<File | null>(null);
  const [fileB, setFileB] = useState<File | null>(null);
  const [draftMappings, setDraftMappings] = useState<ManualMapping[]>(initialRun?.mappings ?? []);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(!initialRun);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialRun) return;
    let active = true;
    void fetch("/api/runs", { method: "POST" }).then(parseRun)
      .then((created) => { if (active) setRun(created); })
      .catch(() => { if (active) setError("The API is unavailable. Start the Samewise API and try again."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [initialRun]);

  const selectedCandidate = run?.candidates.find((candidate) => candidate.candidateId === selectedCandidateId) ?? null;
  const unresolved = run?.conflicts.filter((conflict) => !conflict.resolution) ?? [];
  const pendingReview = useMemo(() => {
    if (!run) return [];
    const decided = new Set(run.decisions.map((decision) => decision.candidateId));
    const humanSameA = new Set(run.decisions.filter((decision) => decision.humanDecision === "same_entity").map((decision) => decision.aRowId));
    const rejected = new Set(run.decisions.filter((decision) => decision.humanDecision === "different_entity").map((decision) => decision.candidateId));
    const linkedA = new Set(humanSameA);
    for (const candidate of run.candidates) {
      if (candidate.rank === 1 && candidate.band === "proposed_match" && !humanSameA.has(candidate.aRowId) && !rejected.has(candidate.candidateId)) linkedA.add(candidate.aRowId);
    }
    return run.candidates.filter((candidate) => candidate.band === "needs_review" && !decided.has(candidate.candidateId) && !linkedA.has(candidate.aRowId));
  }, [run]);

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

  async function saveAndRun() {
    if (!run) return;
    if (!draftMappings.some((mapping) => mapping.role === "identity")) { setError("Add at least one identity-evidence mapping."); return; }
    await action(async () => {
      const mapped = await parseRun(await fetch(`/api/runs/${run.runId}/mappings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mappings: draftMappings }) }));
      return parseRun(await fetch(`/api/runs/${mapped.runId}/match`, { method: "POST" }));
    }, "results");
  }

  function review(candidate: CandidatePair) { setSelectedCandidateId(candidate.candidateId); setScreen("review"); }
  async function decide(decision: "same_entity" | "different_entity") {
    if (!run || !selectedCandidate) return;
    const updated = await action(() => fetch(`/api/runs/${run.runId}/candidates/${selectedCandidate.candidateId}/decisions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) }).then(parseRun));
    if (updated) setScreen(decision === "same_entity" && updated.conflicts.some((conflict) => conflict.candidateId === selectedCandidate.candidateId && !conflict.resolution) ? "resolution" : "results");
  }
  async function resolveConflict(conflictId: string, actionName: "use_a" | "use_b") {
    if (!run) return;
    await action(() => fetch(`/api/runs/${run.runId}/conflicts/${conflictId}/resolutions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: actionName }) }).then(parseRun));
  }
  async function downloadExport() {
    if (!run) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/runs/${run.runId}/export`); if (!response.ok) throw new Error("Export could not be created.");
      const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a");
      link.href = url; link.download = `samewise-${run.runId}.csv`; link.click(); URL.revokeObjectURL(url);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Export could not be created."); }
    finally { setBusy(false); }
  }

  return <main className="app-shell">
    <header className="topbar"><div><span className="mark">S</span><strong>Samewise</strong></div><p>Trusted reconciliation workspace</p></header>
    <div className="workspace">
      <nav className="stepper" aria-label="Reconciliation progress"><p className="eyebrow">Reconciliation run</p><ol>{STEPS.map((step, index) => <li key={step.id} className={screen === step.id ? "active" : ""}><span>{index + 1}</span>{step.label}</li>)}</ol><div className="principle"><strong>Identity ≠ survivorship</strong><p>First confirm the entity. Then choose which conflicting values survive.</p></div></nav>
      <section className="content">
        {error && <div className="error-banner" role="alert">{error}</div>}{busy && <div className="busy" aria-live="polite">Working…</div>}
        {screen === "upload" && <section aria-labelledby="upload-title"><p className="eyebrow">Step 1 · Immutable sources</p><h1 id="upload-title">Start with two messy CSV files.</h1><p className="lede">Samewise fingerprints and profiles each source without rewriting it.</p><div className="upload-grid"><FilePicker side="A" file={fileA} onChange={setFileA} /><FilePicker side="B" file={fileB} onChange={setFileB} /></div><button className="primary" onClick={() => void upload()} disabled={busy}>Upload & profile</button><p className="fine-print">CSV only · 2 MiB per file · source bytes remain unchanged</p></section>}
        {screen === "profile" && run?.datasets.A && run.datasets.B && <section aria-labelledby="profile-title"><p className="eyebrow">Step 2 · Source profile</p><h1 id="profile-title">Know what arrived.</h1><p className="lede">Profiles are derived in the matcher process. Samples are intentionally limited.</p><div className="profile-grid"><ProfileCard profile={run.datasets.A} /><ProfileCard profile={run.datasets.B} /></div><button className="primary" onClick={() => setScreen("mapping")}>Map corresponding fields</button></section>}
        {screen === "mapping" && run?.datasets.A && run.datasets.B && <section aria-labelledby="mapping-title"><p className="eyebrow">Step 3 · Manual mapping</p><h1 id="mapping-title">Tell Samewise what corresponds.</h1><p className="lede">Identity evidence affects matching. Comparison fields are inspected only after identity is established.</p><div className="mapping-list">{draftMappings.map((mapping, index) => <MappingRow key={mapping.mappingId} mapping={mapping} aColumns={run.datasets.A!.columns.map((column) => column.name)} bColumns={run.datasets.B!.columns.map((column) => column.name)} onChange={(next) => setDraftMappings(draftMappings.map((item, itemIndex) => itemIndex === index ? next : item))} onRemove={() => setDraftMappings(draftMappings.filter((_, itemIndex) => itemIndex !== index))} />)}</div><div className="actions"><button className="secondary" onClick={addMapping}>+ Add mapping</button><button className="primary" onClick={() => void saveAndRun()} disabled={busy}>Save mappings & run baseline</button></div></section>}
        {screen === "results" && run?.summary && <section aria-labelledby="results-title"><p className="eyebrow">Step 4 · Baseline results</p><h1 id="results-title">A transparent first pass.</h1><p className="lede">Scores are deterministic baseline scores—not calibrated probabilities. Matched includes baseline-proposed and human-confirmed identity links; their source remains distinct in the export. Only B means no identity link is established, even when the row appears as a review alternative.</p><div className="summary-grid"><Metric label="Matched" value={run.summary.matched} /><Metric label="Needs review" value={run.summary.needsReview} accent /><Metric label="Only A" value={run.summary.onlyA} /><Metric label="Only B" value={run.summary.onlyB} /></div><div className="result-list"><h2>Review candidates</h2>{pendingReview.length ? pendingReview.slice(0, 8).map((candidate) => <button className="candidate-row" key={candidate.candidateId} onClick={() => review(candidate)}><span><strong>{candidate.aRowId}</strong> ↔ <strong>{candidate.bRowId}</strong><small>{candidate.rank > 1 ? `Alternative ${candidate.rank}` : candidate.collision ? "Shared preferred candidate" : "Human review required"}</small></span><b>{candidate.baselineScore.toFixed(3)}</b></button>) : <p className="empty">No pending candidates require review.</p>}</div><div className="actions"><button className="secondary" onClick={() => setScreen("resolution")}>View field conflicts ({unresolved.length})</button><button className="primary" onClick={() => setScreen("export")}>Prepare export</button></div></section>}
        {screen === "review" && selectedCandidate && <section aria-labelledby="review-title"><p className="eyebrow">Step 5 · Identity decision</p><h1 id="review-title">Are these the same real-world entity?</h1><div className="decision-callout">This decision will not choose any conflicting field value.</div><div className="record-pair"><RecordCard title={`Dataset A · ${selectedCandidate.aRowId}`} record={selectedCandidate.aRecord} /><RecordCard title={`Dataset B · ${selectedCandidate.bRowId}`} record={selectedCandidate.bRecord} /></div><h2>Evidence shown</h2><div className="evidence-table">{selectedCandidate.evidence.map((item) => <div key={item.mappingId}><span>{item.label}<small>{item.outcome.replaceAll("_", " ")}</small></span><code>{item.aValue || "—"}</code><code>{item.bValue || "—"}</code><b>{item.contribution.toFixed(3)}</b></div>)}</div><div className="score-note">Baseline score <strong>{selectedCandidate.baselineScore.toFixed(3)}</strong> · matcher {run?.matcherVersion}</div><div className="decision-actions"><button className="different" onClick={() => void decide("different_entity")}>Different entity</button><button className="same" onClick={() => void decide("same_entity")}>Same entity</button></div></section>}
        {screen === "resolution" && run && <section aria-labelledby="resolution-title"><p className="eyebrow">Step 6 · Field resolution</p><h1 id="resolution-title">Identity is settled. Values are not.</h1><p className="lede">Each choice below is a separate, provenance-retaining user action.</p><div className="conflicts">{run.conflicts.length ? run.conflicts.map((conflict) => <article className="conflict-card" key={conflict.conflictId}><header><div><small>Mapped field</small><h2>{conflict.label}</h2></div>{conflict.resolution && <span className="resolved">Resolved · use {conflict.resolution.chosenSource}</span>}</header><div className="conflict-values"><div><small>Dataset A</small><strong>{conflict.aValue || "Empty"}</strong><button disabled={!!conflict.resolution} onClick={() => void resolveConflict(conflict.conflictId, "use_a")}>Use A</button></div><div><small>Dataset B</small><strong>{conflict.bValue || "Empty"}</strong><button disabled={!!conflict.resolution} onClick={() => void resolveConflict(conflict.conflictId, "use_b")}>Use B</button></div></div></article>) : <p className="empty">No field conflicts are available. Confirm a same-entity review candidate first.</p>}</div><div className="actions"><button className="secondary" onClick={() => setScreen("results")}>Back to results</button><button className="primary" onClick={() => setScreen("export")}>Continue to export</button></div></section>}
        {screen === "export" && run?.summary && <section aria-labelledby="export-title"><p className="eyebrow">Step 7 · Reconciliation export</p><h1 id="export-title">Export without hiding uncertainty.</h1><p className="lede">A-only, B-only, identity source, matcher version, mapped values, and unresolved conflicts remain explicit.</p><div className="export-card"><div><small>Format</small><strong>CSV</strong></div><div><small>Unresolved conflicts</small><strong>{unresolved.length}</strong></div><div><small>Formula safety</small><strong>Enabled</strong></div></div>{unresolved.length > 0 && <div className="warning">The export will leave {unresolved.length} trusted value{unresolved.length === 1 ? "" : "s"} unresolved.</div>}<div className="actions"><button className="secondary" onClick={() => setScreen("resolution")}>Review conflicts</button><button className="primary" onClick={() => void downloadExport()} disabled={busy}>Download reconciliation CSV</button></div></section>}
      </section>
    </div>
  </main>;
}

function FilePicker({ side, file, onChange }: { side: "A" | "B"; file: File | null; onChange: (file: File | null) => void }) { return <label className="file-picker"><span className="dataset-badge">{side}</span><strong>Dataset {side}</strong><small>{file?.name ?? "Choose a CSV source"}</small><input aria-label={`Dataset ${side} CSV`} type="file" accept=".csv,text/csv" onChange={(event) => onChange(event.target.files?.[0] ?? null)} /></label>; }
function ProfileCard({ profile }: { profile: NonNullable<RunView["datasets"]["A"]> }) { return <article className="profile-card"><header><span className="dataset-badge">{profile.side}</span><div><h2>{profile.originalFilename}</h2><small>{profile.rowCount} rows · SHA-256 {profile.sha256.slice(0, 10)}…</small></div></header><div className="profile-columns">{profile.columns.map((column) => <div key={column.name}><strong>{column.name}</strong><span>{column.inferredType}</span><small>{column.nullCount} null · {column.distinctCount} distinct</small><p>{column.samples.join(" · ") || "No sample"}</p></div>)}</div></article>; }
function MappingRow({ mapping, aColumns, bColumns, onChange, onRemove }: { mapping: ManualMapping; aColumns: string[]; bColumns: string[]; onChange: (mapping: ManualMapping) => void; onRemove: () => void }) { return <div className={`mapping-row ${mapping.role}`}><input aria-label="Mapping label" value={mapping.label} onChange={(event) => onChange({ ...mapping, label: event.target.value })} /><select aria-label="Dataset A column" value={mapping.aColumn} onChange={(event) => onChange({ ...mapping, aColumn: event.target.value })}>{aColumns.map((column) => <option key={column}>{column}</option>)}</select><span>↔</span><select aria-label="Dataset B column" value={mapping.bColumn} onChange={(event) => onChange({ ...mapping, bColumn: event.target.value })}>{bColumns.map((column) => <option key={column}>{column}</option>)}</select><select aria-label="Mapping role" value={mapping.role} onChange={(event) => onChange({ ...mapping, role: event.target.value as ManualMapping["role"] })}><option value="identity">Identity evidence</option><option value="comparison">Post-identity comparison</option></select><select aria-label="Normalizer" value={mapping.normalizer} onChange={(event) => onChange({ ...mapping, normalizer: event.target.value as ManualMapping["normalizer"] })}><option value="text">Text</option><option value="phone">Phone</option><option value="email">Email</option><option value="number">Number</option><option value="date">Date</option></select><button className="icon-button" aria-label={`Remove ${mapping.label}`} onClick={onRemove}>×</button></div>; }
function Metric({ label, value, accent = false }: { label: string; value: number; accent?: boolean }) { return <article className={accent ? "metric accent" : "metric"}><small>{label}</small><strong>{value}</strong></article>; }
function RecordCard({ title, record }: { title: string; record: Record<string, string> }) { return <article className="record-card"><h2>{title}</h2><dl>{Object.entries(record).slice(0, 8).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || "—"}</dd></div>)}</dl></article>; }
