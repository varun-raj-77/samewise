import {
  ConflictPageSchema, MergePlanPreviewSchema, RunSummarySchema,
  type ConflictPage, type FieldPolicyInput, type MergePlanPreview, type RuleStrategy, type RunSummary,
} from "@samewise/contracts";
import { useEffect, useState } from "react";

interface Props {
  run: RunSummary; busy: boolean; onRun: (run: RunSummary) => void; onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void; onReview: () => void; onBack: () => void; onContinue: () => void;
}

async function apiError(response: Response): Promise<Error> {
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return new Error(payload?.error?.message ?? "Samewise could not complete that request.");
}

function ruleLabel(rule: FieldPolicyInput | null): string {
  if (!rule) return "Choose rule";
  if (rule.strategy === "prefer_non_null") return "Use the value that exists";
  if (rule.strategy === "prefer_newest") return "Use the most recently updated value";
  if (rule.strategy === "keep_both") return "Preserve both values";
  return `Prefer Dataset ${rule.trustedSource ?? "A"} when available`;
}

export function SurvivorshipWorkspace({ run, busy, onRun, onBusy, onError, onReview, onBack, onContinue }: Props) {
  const comparisonMappings = run.mappings.filter((mapping) => mapping.includeInMerge);
  const unresolvedIdentity = run.reviewProgress.remaining + run.reviewProgress.deferred;
  const [draft, setDraft] = useState<Record<string, FieldPolicyInput>>(() => Object.fromEntries((run.survivorshipPolicy?.fieldPolicies ?? []).map(({ semanticField, strategy, trustedSource, timestampMappingId }) => [semanticField, { semanticField, strategy, ...(trustedSource ? { trustedSource } : {}), ...(timestampMappingId ? { timestampMappingId } : {}) }])));
  const [preview, setPreview] = useState<MergePlanPreview | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [offset, setOffset] = useState(0);
  const [conflictPage, setConflictPage] = useState<ConflictPage | null>(null);
  const [resolvedPage, setResolvedPage] = useState<ConflictPage | null>(null);
  const [resolvedOffset, setResolvedOffset] = useState(0);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);
  const dateMappings = run.mappings.filter((mapping) => mapping.normalizer === "date");
  const fields = (run.conflictSummary.fields ?? []).filter((field) => field.total > 0);
  const configured = comparisonMappings.flatMap((mapping) => draft[mapping.mappingId] ? [draft[mapping.mappingId]!] : []);
  const canReviewExceptions = Boolean(run.conflictSummary.rulesApplied);

  useEffect(() => {
    if (!canReviewExceptions || unresolvedIdentity > 0 || run.conflictSummary.unresolved === 0) { setConflictPage(null); return; }
    let active = true;
    setConflictError(null);
    void fetch(`/api/runs/${encodeURIComponent(run.runId)}/conflicts?offset=${offset}&limit=50&status=unresolved`)
      .then(async (response) => { if (!response.ok) throw await apiError(response); return ConflictPageSchema.parse(await response.json()); })
      .then((loaded) => { if (active) setConflictPage(loaded); })
      .catch((error) => { if (active) setConflictError(error instanceof Error ? error.message : "Exceptions could not be loaded."); });
    return () => { active = false; };
  }, [run, offset, requestVersion, canReviewExceptions, unresolvedIdentity]);

  useEffect(() => {
    if (run.conflictSummary.resolved === 0) { setResolvedPage(null); return; }
    let active = true;
    void fetch(`/api/runs/${encodeURIComponent(run.runId)}/conflicts?offset=${resolvedOffset}&limit=50&status=resolved`)
      .then(async (response) => { if (!response.ok) throw await apiError(response); return ConflictPageSchema.parse(await response.json()); })
      .then((loaded) => { if (active) setResolvedPage(loaded); })
      .catch((error) => { if (active) onError(error instanceof Error ? error.message : "Handled decisions could not be loaded."); });
    return () => { active = false; };
  }, [run, resolvedOffset, onError]);

  function updateRule(mappingId: string, strategy: RuleStrategy | "") {
    setPreview(null);
    setDraft((current) => {
      const next = { ...current };
      if (!strategy) delete next[mappingId];
      else next[mappingId] = { semanticField: mappingId, strategy,
        ...(strategy === "prefer_trusted_source" ? { trustedSource: current[mappingId]?.trustedSource ?? "A" as const } : {}),
        ...(strategy === "prefer_newest" ? { timestampMappingId: current[mappingId]?.timestampMappingId ?? dateMappings[0]?.mappingId ?? "" } : {}),
      };
      return next;
    });
  }

  function updateOption(mappingId: string, option: Partial<FieldPolicyInput>) {
    setPreview(null);
    setDraft((current) => ({ ...current, [mappingId]: { ...current[mappingId]!, ...option } }));
  }

  async function planRequest(kind: "preview" | "apply") {
    onBusy(true); onError(null);
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(run.runId)}/merge-plan-${kind}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kind === "preview" ? { fieldPolicies: configured } : { fieldPolicies: configured, previewToken: preview?.previewToken }),
      });
      if (!response.ok) throw await apiError(response);
      if (kind === "preview") {
        const value = MergePlanPreviewSchema.parse(await response.json());
        setPreview(value);
        setAnnouncement(`Merge plan preview: ${value.willHandle} will be handled; ${value.willRemain} will remain unresolved.`);
      } else {
        const value = await response.json() as { run: unknown; appliedCount: number };
        onRun(RunSummarySchema.parse(value.run));
        setPreview(null);
        setAnnouncement(`Merge plan applied to ${value.appliedCount} differences.`);
      }
    } catch (error) {
      setPreview(null);
      onError(error instanceof Error ? error.message : "Merge plan request failed.");
    } finally { onBusy(false); }
  }

  async function resolve(conflictId: string, action: "use_a" | "use_b" | "keep_both", replace = false) {
    onBusy(true); onError(null); setPreview(null);
    try {
      const response = await fetch(`/api/runs/${run.runId}/conflicts/${conflictId}/resolutions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, replace }),
      });
      if (!response.ok) throw await apiError(response);
      onRun(RunSummarySchema.parse(await response.json()));
      setAnnouncement("Manual value decision recorded.");
    } catch (error) { onError(error instanceof Error ? error.message : "Value decision failed."); }
    finally { onBusy(false); }
  }

  async function clear(conflictId: string) {
    onBusy(true); onError(null); setPreview(null);
    try {
      const response = await fetch(`/api/runs/${run.runId}/conflicts/${conflictId}/resolution`, { method: "DELETE" });
      if (!response.ok) throw await apiError(response);
      onRun(RunSummarySchema.parse(await response.json()));
      setAnnouncement("Value decision cleared.");
    } catch (error) { onError(error instanceof Error ? error.message : "Could not clear the value decision."); }
    finally { onBusy(false); }
  }

  if (unresolvedIdentity > 0) return <EmptyResolutionState title="Identity review isn't finished" description={`${unresolvedIdentity} possible match${unresolvedIdentity === 1 ? "" : "es"} still need${unresolvedIdentity === 1 ? "s" : ""} a Same entity or Different entities decision before merge values can be resolved.`} action="Go to Review matches" onAction={onReview} onBack={onBack} />;
  if (comparisonMappings.length === 0) return <EmptyResolutionState title="No merge fields were configured" description="Identity reconciliation can still complete, but no business fields were selected for merged-value reconciliation. Start a new reconciliation to change this confirmed setup." onBack={onBack} onContinue={onContinue} />;
  if (run.conflictSummary.total === 0) return <EmptyResolutionState title="No conflicting values need resolution" description="Identity is confirmed and merge fields are configured. Samewise found no differing values across those fields for confirmed identities." onBack={onBack} onContinue={onContinue} />;

  return <section aria-labelledby="resolution-title" className="survivorship-workspace">
    <p className="eyebrow">Step 4 · Merge values</p><h1 id="resolution-title">Choose which values to keep.</h1>
    <p className="lede">{run.conflictSummary.total} differences across {run.trustedExportReadiness.eligibleConfirmedCount} matched records. Configure field rules together, preview their exact impact, then apply the plan.</p>
    <p className="sr-announcement" aria-live="polite">{announcement}</p>
    <div className="survivorship-summary" aria-label="Conflict status"><div><small>Total differences</small><strong>{run.conflictSummary.total}</strong></div><div><small>Handled</small><strong>{run.conflictSummary.resolved}</strong></div><div><small>Still need attention</small><strong>{run.conflictSummary.unresolved}</strong></div></div>
    <section className="merge-fields" aria-labelledby="merge-fields-title"><h2 id="merge-fields-title">Merge plan by field</h2>
      {fields.map((field) => { const rule = draft[field.mappingId] ?? null; const impact = preview?.fields.find((item) => item.semanticField === field.mappingId); return <article key={field.mappingId} className="merge-field-row">
        <div className="merge-field-heading"><div><h3>{field.label}</h3><small>{field.total} differences · {field.unresolved} still need attention</small></div><strong>{ruleLabel(rule)}</strong></div>
        <div className="merge-field-controls"><label>Rule for {field.label}<select aria-label={`Rule for ${field.label}`} value={rule?.strategy ?? ""} onChange={(event) => updateRule(field.mappingId, event.target.value as RuleStrategy | "")}><option value="">Choose rule</option><option value="prefer_non_null">Use the value that exists</option><option value="prefer_newest" disabled={dateMappings.length === 0}>Use the most recently updated value</option><option value="prefer_trusted_source">Prefer a dataset when available</option><option value="keep_both">Preserve both values</option></select></label>
          {rule?.strategy === "prefer_trusted_source" && <label>Trusted source<select aria-label={`Trusted source for ${field.label}`} value={rule.trustedSource ?? "A"} onChange={(event) => updateOption(field.mappingId, { trustedSource: event.target.value as "A" | "B" })}><option value="A">Dataset A</option><option value="B">Dataset B</option></select></label>}
          {rule?.strategy === "prefer_newest" && <label>Timestamp mapping<select aria-label={`Timestamp for ${field.label}`} value={rule.timestampMappingId ?? ""} onChange={(event) => updateOption(field.mappingId, { timestampMappingId: event.target.value })}>{dateMappings.map((mapping) => <option key={mapping.mappingId} value={mapping.mappingId}>{mapping.label}</option>)}</select></label>}</div>
        {field.suggestedRule && !rule && <p className="safe-suggestion">Suggested: <button type="button" className="secondary" onClick={() => updateRule(field.mappingId, "prefer_non_null")}>Use the value that exists</button> because every unresolved difference has a value on only one side. {field.unresolved} / {field.unresolved} handled, 0 remain if applied. Preview before applying.</p>}
        <p className="merge-field-impact">{impact ? `${impact.willHandle} will be handled · ${impact.willRemain} will remain · ${impact.manualPreserved} manual decisions preserved` : `${field.resolved} handled · ${field.unresolved} remain`}</p>
      </article>; })}
    </section>
    <div className="merge-plan-actions"><button type="button" className="primary" disabled={busy || configured.length === 0} onClick={() => void planRequest("preview")}>Preview merge plan</button></div>
    {preview && <section className="merge-plan-preview" aria-labelledby="merge-plan-preview-title" aria-live="polite"><h2 id="merge-plan-preview-title">Merge plan preview</h2><p>{preview.configuredFields} fields configured · {preview.totalDifferences} total differences</p><dl><div><dt>Will be handled</dt><dd>{preview.willHandle}</dd></div><div><dt>Preserved as both values</dt><dd>{preview.preservedBoth}</dd></div><div><dt>Will remain unresolved</dt><dd>{preview.willRemain}</dd></div><div><dt>Manual decisions preserved</dt><dd>{preview.manualPreserved}</dd></div></dl><p>Nothing changes until you apply this plan.</p><button type="button" className="primary" disabled={busy} onClick={() => void planRequest("apply")}>Apply merge plan</button></section>}
    <section className="individual-exceptions" aria-labelledby="exceptions-title"><h2 id="exceptions-title">Individual exceptions</h2>
      {!canReviewExceptions ? <p>Apply merge rules first. Differences the rules cannot resolve will appear here.</p> : run.conflictSummary.unresolved === 0 ? <p>All merge differences have an explicit outcome.</p> : <details><summary>Review {run.conflictSummary.unresolved} exceptions</summary>
        {conflictError && <div className="warning" role="alert">{conflictError}<button type="button" onClick={() => setRequestVersion((value) => value + 1)}>Retry</button></div>}
        {!conflictError && !conflictPage && <p role="status">Loading exceptions…</p>}
        {conflictPage?.items.filter((item) => !item.resolution).map((conflict) => <article className="conflict-card is-unresolved" key={conflict.conflictId}><header><div><small>{conflict.aRowId} ↔ {conflict.bRowId}</small><h3>{conflict.label}</h3></div><span className="resolution-badge">Unresolved</span></header><div className="conflict-values"><div><small>Dataset A</small><strong>{conflict.aValue || "Empty"}</strong><button disabled={busy} onClick={() => void resolve(conflict.conflictId, "use_a")}>Use A</button></div><div><small>Dataset B</small><strong>{conflict.bValue || "Empty"}</strong><button disabled={busy} onClick={() => void resolve(conflict.conflictId, "use_b")}>Use B</button></div></div><div className="conflict-footer"><button className="secondary" disabled={busy} onClick={() => void resolve(conflict.conflictId, "keep_both")}>Preserve both</button></div></article>)}
        {conflictPage && <div className="actions" aria-label="Exception pagination"><button type="button" className="secondary" disabled={conflictPage.page.previousOffset === null} onClick={() => setOffset(conflictPage.page.previousOffset ?? 0)}>Previous</button><button type="button" className="secondary" disabled={conflictPage.page.nextOffset === null} onClick={() => setOffset(conflictPage.page.nextOffset ?? offset)}>Next</button></div>}
      </details>}</section>
    {run.conflictSummary.resolved > 0 && <details className="handled-decisions"><summary>Inspect {run.conflictSummary.resolved} handled decisions</summary>{resolvedPage?.items.map((conflict) => <article className="conflict-card is-resolved" key={conflict.conflictId}><h3>{conflict.label}</h3><p>{conflict.resolution?.reason}</p><small>{conflict.resolution?.strategy === "use_a" ? "Use Dataset A" : conflict.resolution?.strategy === "use_b" ? "Use Dataset B" : conflict.resolution ? ruleLabel({ semanticField: conflict.mappingId, strategy: conflict.resolution.strategy, trustedSource: conflict.resolution.chosenSource ?? undefined }) : ""} · {conflict.resolution?.policyVersion ?? "manual action"} · {conflict.resolution?.ruleId ?? "manual decision"}</small><div className="conflict-footer"><button className="secondary" disabled={busy} onClick={() => void resolve(conflict.conflictId, "use_a", true)}>Change to Dataset A</button><button className="secondary" disabled={busy} onClick={() => void resolve(conflict.conflictId, "use_b", true)}>Change to Dataset B</button><button className="secondary" disabled={busy} onClick={() => void resolve(conflict.conflictId, "keep_both", true)}>Change to Preserve both</button><button className="secondary" disabled={busy} onClick={() => void clear(conflict.conflictId)}>Clear resolution</button></div></article>)}{resolvedPage && <div className="actions" aria-label="Handled decision pagination"><button type="button" className="secondary" disabled={resolvedPage.page.previousOffset === null} onClick={() => setResolvedOffset(resolvedPage.page.previousOffset ?? 0)}>Previous</button><button type="button" className="secondary" disabled={resolvedPage.page.nextOffset === null} onClick={() => setResolvedOffset(resolvedPage.page.nextOffset ?? resolvedOffset)}>Next</button></div>}</details>}
    <div className="actions"><button className="secondary" onClick={onBack}>Back to results</button>{run.conflictSummary.unresolved === 0 ? <button className="primary" onClick={onContinue}>Continue to Export</button> : <p role="status">Finish merge rules before exporting reconciled data.</p>}</div>
  </section>;
}

function EmptyResolutionState({ title, description, action, onAction, onBack, onContinue }: { title: string; description: string; action?: string; onAction?: () => void; onBack: () => void; onContinue?: () => void }) {
  return <section aria-labelledby="resolution-title" className="survivorship-workspace"><p className="eyebrow">Step 4 · Merge values</p><h1 id="resolution-title">Choose merge rules.</h1><section className="resolution-empty-state" aria-labelledby="resolution-state-title"><span aria-hidden="true">—</span><div><h2 id="resolution-state-title">{title}</h2><p>{description}</p></div></section><div className="actions"><button className="secondary" onClick={onBack}>Back to results</button>{action && onAction && <button className="primary" onClick={onAction}>{action}</button>}{onContinue && <button className="primary" onClick={onContinue}>Continue to Export</button>}</div></section>;
}
