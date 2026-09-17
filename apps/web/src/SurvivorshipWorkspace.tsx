import {
  ConflictPageSchema,
  ResolutionPreviewSchema,
  RunSummarySchema,
  type ConflictPage,
  type FieldPolicyInput,
  type ResolutionPreview,
  type RuleStrategy,
  type RunSummary,
} from "@samewise/contracts";
import { useEffect, useState } from "react";

interface Props {
  run: RunSummary;
  busy: boolean;
  onRun: (run: RunSummary) => void;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
  onBack: () => void;
  onContinue: () => void;
}

async function apiError(response: Response): Promise<Error> {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return new Error(payload?.error?.message ?? "Samewise could not complete that request.");
}

export function SurvivorshipWorkspace({ run, busy, onRun, onBusy, onError, onBack, onContinue }: Props) {
  const comparisonMappings = run.mappings.filter((mapping) => mapping.role === "comparison");
  const [semanticField, setSemanticField] = useState(comparisonMappings[0]?.mappingId ?? "");
  const existingRule = run.survivorshipPolicy?.fieldPolicies.find((rule) => rule.semanticField === semanticField);
  const [strategy, setStrategy] = useState<RuleStrategy>(existingRule?.strategy ?? "prefer_non_null");
  const [trustedSource, setTrustedSource] = useState<"A" | "B">(existingRule?.trustedSource ?? "A");
  const dateMappings = run.mappings.filter((mapping) => mapping.normalizer === "date");
  const [timestampMappingId, setTimestampMappingId] = useState(existingRule?.timestampMappingId ?? dateMappings[0]?.mappingId ?? "");
  const [preview, setPreview] = useState<ResolutionPreview | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [offset, setOffset] = useState(0);
  const [conflictPage, setConflictPage] = useState<ConflictPage | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [conflictRequestVersion, setConflictRequestVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setConflictError(null);
    void fetch(`/api/runs/${encodeURIComponent(run.runId)}/conflicts?offset=${offset}&limit=50`)
      .then(async (response) => {
        if (!response.ok) throw await apiError(response);
        return ConflictPageSchema.parse(await response.json());
      })
      .then((loaded) => { if (active) setConflictPage(loaded); })
      .catch((error) => { if (active) setConflictError(error instanceof Error ? error.message : "Field conflicts could not be loaded."); });
    return () => { active = false; };
  }, [run.runId, run.conflictSummary, offset, conflictRequestVersion]);

  async function runRequest(work: () => Promise<RunSummary>, message: string) {
    onBusy(true); onError(null);
    try {
      const updated = await work();
      onRun(updated); setAnnouncement(message);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Samewise could not complete that request.");
    } finally { onBusy(false); }
  }

  async function manual(conflictId: string, action: "use_a" | "use_b" | "keep_both", replace: boolean) {
    await runRequest(async () => {
      const response = await fetch(`/api/runs/${run.runId}/conflicts/${conflictId}/resolutions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, replace }),
      });
      if (!response.ok) throw await apiError(response);
      return RunSummarySchema.parse(await response.json());
    }, `${action.replaceAll("_", " ")} resolution recorded.`);
  }

  async function clear(conflictId: string) {
    await runRequest(async () => {
      const response = await fetch(`/api/runs/${run.runId}/conflicts/${conflictId}/resolution`, { method: "DELETE" });
      if (!response.ok) throw await apiError(response);
      return RunSummarySchema.parse(await response.json());
    }, "Field resolution cleared. The conflict is unresolved again.");
  }

  function fieldPolicy(): FieldPolicyInput {
    return {
      semanticField,
      strategy,
      ...(strategy === "prefer_trusted_source" ? { trustedSource } : {}),
      ...(strategy === "prefer_newest" ? { timestampMappingId } : {}),
    };
  }

  async function savePolicy() {
    const policies = [
      ...(run.survivorshipPolicy?.fieldPolicies ?? []).filter((rule) => rule.semanticField !== semanticField).map((rule) => ({
        semanticField: rule.semanticField,
        strategy: rule.strategy,
        ...(rule.trustedSource ? { trustedSource: rule.trustedSource } : {}),
        ...(rule.timestampMappingId ? { timestampMappingId: rule.timestampMappingId } : {}),
      })),
      fieldPolicy(),
    ];
    await runRequest(async () => {
      const response = await fetch(`/api/runs/${run.runId}/survivorship-policy`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fieldPolicies: policies }),
      });
      if (!response.ok) throw await apiError(response);
      return RunSummarySchema.parse(await response.json());
    }, "Policy configured. No values were changed; preview it before applying.");
    setPreview(null);
  }

  async function previewRule() {
    const rule = run.survivorshipPolicy?.fieldPolicies.find((item) => item.semanticField === semanticField);
    if (!rule) { onError("Save this field policy before previewing it."); return; }
    onBusy(true); onError(null);
    try {
      const response = await fetch(`/api/runs/${run.runId}/survivorship-preview`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ruleId: rule.ruleId }),
      });
      if (!response.ok) throw await apiError(response);
      const value = ResolutionPreviewSchema.parse(await response.json());
      setPreview(value);
      setAnnouncement(`Preview complete: ${value.resolvableCount} resolvable and ${value.unresolvedCount} unresolved.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Policy preview failed.");
    } finally { onBusy(false); }
  }

  async function applyRule() {
    if (!preview) { onError("Preview this rule before applying it."); return; }
    onBusy(true); onError(null);
    try {
      const response = await fetch(`/api/runs/${run.runId}/survivorship-apply`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ruleId: preview.ruleId }),
      });
      if (!response.ok) throw await apiError(response);
      const payload = await response.json() as { run: unknown; appliedCount: number; unresolvedCount: number; skippedCount: number };
      onRun(RunSummarySchema.parse(payload.run));
      setAnnouncement(`Rule applied to ${payload.appliedCount} conflict(s); ${payload.unresolvedCount} could not resolve and ${payload.skippedCount} were preserved.`);
      setPreview(null);
    } catch (error) {
      setPreview(null);
      onError(error instanceof Error ? error.message : "Policy application failed.");
    } finally { onBusy(false); }
  }

  return <section aria-labelledby="resolution-title" className="survivorship-workspace">
    <p className="eyebrow">Step 6 · Survivorship</p>
    <h1 id="resolution-title">Identity is settled. Values are not.</h1>
    <p className="lede">Inspect source provenance, resolve deliberately, or preview a deterministic field rule before applying it. Identity evidence never chooses a value.</p>
    <p className="sr-announcement" aria-live="polite">{announcement}</p>
    <div className="survivorship-summary" aria-label="Conflict status">
      <div><small>Unresolved</small><strong>{run.conflictSummary.unresolved}</strong></div>
      <div><small>Resolved</small><strong>{run.conflictSummary.resolved}</strong></div>
      <div><small>Confirmed links</small><strong>{run.trustedExportReadiness.eligibleConfirmedCount}</strong></div>
    </div>

    <section className="policy-panel" aria-labelledby="policy-title">
      <header><div><small>Deterministic policy</small><h2 id="policy-title">Preview before apply</h2></div>{run.survivorshipPolicy && <code>{run.survivorshipPolicy.policyVersion}</code>}</header>
      <div className="policy-controls">
        <label>Comparison field<select value={semanticField} onChange={(event) => { setSemanticField(event.target.value); setPreview(null); }}>{comparisonMappings.map((mapping) => <option key={mapping.mappingId} value={mapping.mappingId}>{mapping.label}</option>)}</select></label>
        <label>Rule<select value={strategy} onChange={(event) => { setStrategy(event.target.value as RuleStrategy); setPreview(null); }}>
          <option value="prefer_non_null">Prefer non-null</option><option value="prefer_newest">Prefer newest</option><option value="prefer_trusted_source">Prefer trusted source</option><option value="keep_both">Keep both</option>
        </select></label>
        {strategy === "prefer_trusted_source" && <label>Trusted source<select value={trustedSource} onChange={(event) => setTrustedSource(event.target.value as "A" | "B")}><option value="A">Dataset A</option><option value="B">Dataset B</option></select></label>}
        {strategy === "prefer_newest" && <label>Timestamp mapping<select value={timestampMappingId} onChange={(event) => setTimestampMappingId(event.target.value)}><option value="">Choose mapped date</option>{dateMappings.map((mapping) => <option key={mapping.mappingId} value={mapping.mappingId}>{mapping.label}</option>)}</select></label>}
      </div>
      <div className="policy-actions"><button className="secondary" disabled={busy || !semanticField} onClick={() => void savePolicy()}>Save policy</button><button className="secondary" disabled={busy || !existingRule} onClick={() => void previewRule()}>Preview rule</button><button className="primary" disabled={busy || !preview} onClick={() => void applyRule()}>Apply previewed rule</button></div>
      {preview && <div className="rule-preview" role="status"><strong>Preview: {preview.resolvableCount} resolvable · {preview.unresolvedCount} unresolved · {preview.skippedManualCount} manual preserved</strong><p>{preview.items[0]?.reason ?? "No conflicts are affected by this rule."}</p><small>Affected {preview.affectedCount}. Nothing changes until Apply previewed rule is pressed.</small></div>}
    </section>

    <div className="conflicts">
      {conflictError && <div className="warning" role="alert"><span>{conflictError}</span><button type="button" onClick={() => setConflictRequestVersion((value) => value + 1)}>Retry</button></div>}
      {!conflictError && !conflictPage && <p role="status">Loading field conflicts…</p>}
      {conflictPage?.items.length ? conflictPage.items.map((conflict) => {
        const resolution = conflict.resolution;
        return <article className={`conflict-card ${resolution ? "is-resolved" : "is-unresolved"}`} key={conflict.conflictId}>
          <header><div><small>{conflict.aRowId} ↔ {conflict.bRowId} · {conflict.aColumn} ↔ {conflict.bColumn}</small><h2>{conflict.label}</h2></div><span className="resolution-badge">{resolution ? `${resolution.resolutionSource.replace("_", " ")} · ${resolution.strategy.replaceAll("_", " ")}` : "Unresolved"}</span></header>
          <div className="conflict-values"><div><small>Dataset A · raw value</small><strong>{conflict.aValue || "Empty"}</strong><button aria-pressed={resolution?.strategy === "use_a"} disabled={busy} onClick={() => void manual(conflict.conflictId, "use_a", Boolean(resolution))}>Use A</button></div><div><small>Dataset B · raw value</small><strong>{conflict.bValue || "Empty"}</strong><button aria-pressed={resolution?.strategy === "use_b"} disabled={busy} onClick={() => void manual(conflict.conflictId, "use_b", Boolean(resolution))}>Use B</button></div></div>
          <div className="conflict-footer"><button className="secondary" aria-pressed={resolution?.strategy === "keep_both"} disabled={busy} onClick={() => void manual(conflict.conflictId, "keep_both", Boolean(resolution))}>Keep both</button>{resolution && <button className="secondary" disabled={busy} onClick={() => void clear(conflict.conflictId)}>Clear resolution</button>}</div>
          {resolution && <div className="provenance"><strong>Why this value won</strong><p>{resolution.reason}</p><small>{resolution.chosenSource ? `Selected Dataset ${resolution.chosenSource}` : "Both source values retained in dedicated A/B output columns"} · {resolution.policyVersion ?? "manual action"} · {new Date(resolution.resolvedAt).toLocaleString()}</small>{conflict.resolutionHistory.length > 0 && <small>{conflict.resolutionHistory.length} prior resolution{conflict.resolutionHistory.length === 1 ? "" : "s"} retained.</small>}</div>}
        </article>;
      }) : conflictPage && <p className="empty">No field conflicts are available. Confirm a same-entity review candidate first.</p>}
      {conflictPage && <div className="actions" aria-label="Conflict pagination"><button type="button" className="secondary" disabled={conflictPage.page.previousOffset === null} onClick={() => setOffset(conflictPage.page.previousOffset ?? 0)}>Previous</button><button type="button" className="secondary" disabled={conflictPage.page.nextOffset === null} onClick={() => setOffset(conflictPage.page.nextOffset ?? offset)}>Next</button></div>}
    </div>
    <div className="actions"><button className="secondary" onClick={onBack}>Back to results</button><button className="primary" onClick={onContinue}>Continue to exports</button></div>
  </section>;
}
