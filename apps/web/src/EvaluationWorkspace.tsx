import {
  EvaluationCatalogSchema,
  EvaluationErrorPageSchema,
  HumanReviewEvidenceSchema,
  type EvaluationCatalog,
  type EvaluationError,
  type EvaluationErrorPage,
  type EvaluationMetric,
  type HumanReviewEvidence,
} from "@samewise/contracts";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import "./evaluation-workspace.css";

const ERROR_GROUPS = [
  ["candidate_misses", "Candidate misses"],
  ["ranking_losses", "Ranking errors"],
  ["post_score_losses", "Post-score losses"],
  ["false_auto_matches", "False auto-matches"],
  ["false_unmatched", "False unmatched"],
  ["hard_negatives", "Hard negatives"],
] as const;

const EVALUATION_VIEWS = [
  ["overview", "Overview"],
  ["compare", "Compare"],
  ["errors", "Errors"],
  ["thresholds", "Thresholds"],
  ["human", "Human labels"],
] as const;

type EvaluationView = typeof EVALUATION_VIEWS[number][0];

interface EvaluationWorkspaceProps {
  runId: string | null;
  initialCatalog?: EvaluationCatalog;
  initialHumanEvidence?: HumanReviewEvidence;
  initialErrorPage?: EvaluationErrorPage;
  onBack: () => void;
}

async function json(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("Evaluation evidence is unavailable.");
  return response.json();
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function displayLabel(value: string): string {
  const words = value.replaceAll("_", " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function metric(snapshot: EvaluationCatalog["snapshots"][number], id: string): EvaluationMetric {
  const found = snapshot.metrics.find((item) => item.id === id);
  if (!found) throw new Error(`Missing evaluation metric: ${id}`);
  return found;
}

function MetricCard({ item }: { item: EvaluationMetric }) {
  return <article className="evaluation-metric">
    <h3>{item.label}</h3>
    <strong>{percent(item.value)}</strong>
    <p>{item.numerator.toLocaleString()} / {item.denominator.toLocaleString()}</p>
    <details><summary>Definition</summary><p>{item.description}</p></details>
  </article>;
}

function CompactMetric({ item }: { item: EvaluationMetric }) {
  return <div className="compact-metric">
    <div><strong>{item.label}</strong><span>{item.numerator.toLocaleString()} / {item.denominator.toLocaleString()}</span></div>
    <b>{percent(item.value)}</b>
    <details><summary>Definition</summary><p>{item.description}</p></details>
  </div>;
}

function EvidenceList({ record }: { record: Record<string, string> }) {
  return <dl>{Object.entries(record).slice(0, 8).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || "—"}</dd></div>)}</dl>;
}

function ErrorCard({ error }: { error: EvaluationError }) {
  const details = error as EvaluationError & { failureStage?: string; failureReason?: string; score?: number; rank?: number; autoMatched?: boolean };
  return <article className="evaluation-error-card">
    <header><div><small>{displayLabel(details.failureStage ?? error.group)}</small><h3>{error.aRowId} ↔ {error.bRowId}</h3></div><span>{displayLabel(error.category)}</span></header>
    <p className="error-reason">{details.failureReason ?? "No additional failure reason was recorded."}</p>
    <dl className="error-summary">
      <div><dt>Pipeline stage</dt><dd>{displayLabel(details.failureStage ?? error.group)}</dd></div>
      <div><dt>Taxonomy</dt><dd>{displayLabel(error.category)}</dd></div>
      <div><dt>Evidence score</dt><dd>{details.score?.toFixed(3) ?? "—"}</dd></div>
      <div><dt>Rank</dt><dd>{details.rank ?? "—"}</dd></div>
      <div><dt>Auto-matched</dt><dd>{details.autoMatched === undefined ? "—" : details.autoMatched ? "Yes" : "No"}</dd></div>
    </dl>
    <div className="truth-boundary" role="note"><strong>Evaluation-only truth · {error.evaluationOnlyTruth.label}</strong><p>{error.evaluationOnlyTruth.notice}</p></div>
    <details className="record-disclosure"><summary>Inspect records</summary><div className="record-pair"><section><h4>Visible A record</h4><EvidenceList record={error.aRecord} /></section><section><h4>Visible B record</h4><EvidenceList record={error.bRecord} /></section></div></details>
  </article>;
}

export function EvaluationWorkspace({ runId, initialCatalog, initialHumanEvidence, initialErrorPage }: EvaluationWorkspaceProps) {
  const [catalog, setCatalog] = useState<EvaluationCatalog | null>(initialCatalog ?? null);
  const [human, setHuman] = useState<HumanReviewEvidence | null>(initialHumanEvidence ?? null);
  const [view, setView] = useState<EvaluationView>("overview");
  const [group, setGroup] = useState<EvaluationErrorPage["group"]>(initialErrorPage?.group ?? "candidate_misses");
  const [errorPage, setErrorPage] = useState<EvaluationErrorPage | null>(initialErrorPage ?? null);
  const [selectedErrorId, setSelectedErrorId] = useState<string | null>(initialErrorPage?.items[0]?.id ?? null);
  const [threshold, setThreshold] = useState(0.5);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (initialCatalog) return;
    void fetch("/api/evaluations").then(json).then((value) => setCatalog(EvaluationCatalogSchema.parse(value))).catch((error: Error) => setNotice(error.message));
  }, [initialCatalog]);

  useEffect(() => {
    if (initialHumanEvidence || !runId) return;
    void fetch(`/api/runs/${encodeURIComponent(runId)}/evaluation-evidence`).then(json).then((value) => setHuman(HumanReviewEvidenceSchema.parse(value))).catch(() => setHuman(null));
  }, [initialHumanEvidence, runId]);

  const current = useMemo(() => catalog?.snapshots.find((snapshot) => snapshot.provenance.matcherVersion === "explainable-matcher-v0.2.0") ?? null, [catalog]);
  const baseline = useMemo(() => catalog?.snapshots.find((snapshot) => snapshot.provenance.matcherVersion === "baseline-matcher-v0.1.0") ?? null, [catalog]);
  const comparison = catalog?.comparisons[0] ?? null;

  useEffect(() => {
    if (view !== "errors" || !current || initialErrorPage?.group === group) return;
    setErrorPage(null);
    setSelectedErrorId(null);
    void fetch(`/api/evaluations/${encodeURIComponent(current.id)}/errors?type=${group}&offset=0&limit=20`)
      .then(json)
      .then((value) => {
        const page = EvaluationErrorPageSchema.parse(value);
        setErrorPage(page);
        setSelectedErrorId(page.items[0]?.id ?? null);
      })
      .catch((error: Error) => setNotice(error.message));
  }, [current, group, initialErrorPage, view]);

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, target: EvaluationView) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = EVALUATION_VIEWS.findIndex(([id]) => id === target);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? EVALUATION_VIEWS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + EVALUATION_VIEWS.length) % EVALUATION_VIEWS.length;
    const nextView = EVALUATION_VIEWS[nextIndex]![0];
    setView(nextView);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[nextIndex]?.focus();
  }

  if (!catalog || !current || !baseline || !comparison) return <section className="evaluation-loading" aria-live="polite"><p>{notice ?? "Loading versioned evaluation evidence…"}</p></section>;

  const thresholdRow = current.thresholdAnalysis.find((row) => row.threshold === threshold) ?? current.thresholdAnalysis[0];
  const primary = ["candidate_recall", "auto_match_precision", "end_to_end_recovery", "review_rate"].map((id) => metric(current, id));
  const secondary = ["top1_true_candidate_rate", "candidate_reduction_ratio"].map((id) => metric(current, id));
  const selectedError = errorPage?.items.find((error) => error.id === selectedErrorId) ?? errorPage?.items[0] ?? null;

  return <section className="evaluation-workspace" aria-labelledby="evaluation-title">
    <header className="evaluation-heading"><h1 id="evaluation-title">Evaluation</h1><p>Quality, regressions, and failure evidence for this matcher snapshot.</p></header>

    <section className="evaluation-context" aria-labelledby="evaluated-title">
      <div><h2 id="evaluated-title">{current.fixture.name}</h2><span>{displayLabel(current.source.type)}</span><span>{current.provenance.matcherVersion.replace("explainable-matcher-", "matcher ")}</span></div>
      <p>{current.source.caveat}</p>
      <details><summary>Benchmark details</summary><dl><div><dt>Dataset size</dt><dd>{current.fixture.aRows.toLocaleString()} A · {current.fixture.bRows.toLocaleString()} B</dd></div><div><dt>Matcher</dt><dd>{current.provenance.matcherVersion}</dd></div><div><dt>Candidate engine</dt><dd>{current.provenance.candidateEngineVersion}</dd></div><div><dt>Evaluation</dt><dd>{current.evaluationVersion}</dd></div><div><dt>Snapshot hash</dt><dd>{current.contentHash.slice(0, 12)}</dd></div></dl></details>
    </section>

    <div className="evaluation-tabs" role="tablist" aria-label="Evaluation views">{EVALUATION_VIEWS.map(([id, label]) => <button id={`evaluation-tab-${id}`} role="tab" aria-selected={view === id} aria-controls={`evaluation-panel-${id}`} tabIndex={view === id ? 0 : -1} key={id} onClick={() => setView(id)} onKeyDown={(event) => navigateTabs(event, id)}>{label}</button>)}</div>

    <div id={`evaluation-panel-${view}`} className="evaluation-view" role="tabpanel" aria-labelledby={`evaluation-tab-${view}`}>
      {view === "overview" && <>
        <section className={current.gateResult.passed ? "quality-status passed" : "quality-status failed"} aria-labelledby="quality-status-title"><div><span>Quality gates</span><h2 id="quality-status-title">{current.gateResult.passed ? "All quality gates pass" : "Quality gates need attention"}</h2></div><strong>{current.gateResult.passed ? "PASS" : "FAIL"}</strong></section>
        <section aria-labelledby="primary-metrics-title"><h2 id="primary-metrics-title" className="section-title">Matcher quality</h2><div className="evaluation-metric-grid">{primary.map((item) => <MetricCard key={item.id} item={item} />)}</div></section>
        <section className="safety-signals" aria-label="Safety signals"><div><strong>{current.counts.falseAutoMatches}</strong><span>false auto-matches</span></div><div><strong>{current.counts.hardNegativeAutoMatches}</strong><span>hard-negative auto-matches</span></div></section>
        <section className="pipeline-section" aria-labelledby="pipeline-title"><div className="section-heading"><div><h2 id="pipeline-title">Pair-level pipeline</h2><p>Where true links were lost</p></div></div><ol className="evaluation-pipeline"><li><strong>{current.decomposition.pairLevel.trueLinks}</strong><span>True links</span></li><li><strong>{current.decomposition.pairLevel.candidateRetained}</strong><span>Candidate set</span></li><li><strong>{current.decomposition.pairLevel.featureScored}</strong><span>Scored</span></li><li><strong>{current.decomposition.pairLevel.recoverable}</strong><span>Recoverable</span></li><li><strong>{current.decomposition.pairLevel.autoMatched}</strong><span>Auto matched</span></li></ol><p className="metric-note">Pair-level links are distinct from the {current.decomposition.aRowLevel.matchable} matchable A-row denominator used by review rate.</p></section>
        <details className="overview-disclosure"><summary>More metrics</summary><div className="compact-metrics">{secondary.map((item) => <CompactMetric key={item.id} item={item} />)}</div></details>
        <details className="overview-disclosure"><summary>View gate details</summary><ul className="gate-list">{current.gateResult.checks.map((check) => <li key={check.id}><strong className={check.passed ? "gate-pass" : "gate-fail"}>{check.passed ? "PASS" : "FAIL"}</strong><span>{check.id.replaceAll("_", " ")}</span><small>actual {check.actual ?? "undefined"} · policy {check.expected}</small></li>)}</ul><p className="metric-note">Policy {current.gateResult.configVersion}. Baseline status: <strong>{baseline.gateResult.passed ? "passed" : "failed"}</strong>. Gate results are evidence, not an automatic overall winner.</p></details>
      </>}

      {view === "compare" && <section aria-labelledby="comparison-title"><header className="view-heading"><div><h2 id="comparison-title">Version comparison</h2><p>Same frozen evidence, version-to-version changes.</p></div><span className={comparison.compatible ? "compatibility compatible" : "compatibility failed"}>{comparison.status}</span></header>{comparison.reasons.length > 0 && <ul>{comparison.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}<div className="table-scroll"><table><caption>Baseline matcher compared with explainable matcher v0.2 on compatible evidence</caption><thead><tr><th scope="col">Metric</th><th scope="col">{baseline.provenance.matcherVersion}</th><th scope="col">{current.provenance.matcherVersion}</th><th scope="col">Delta</th></tr></thead><tbody>{comparison.metrics.filter((row) => ["auto_match_precision", "review_rate", "top1_true_candidate_rate", "candidate_recall", "end_to_end_recovery"].includes(row.metricId)).map((row) => <tr key={row.metricId}><th scope="row">{row.label}</th><td>{percent(row.versionA)}</td><td>{percent(row.versionB)}</td><td>{row.delta === null ? "—" : `${row.delta >= 0 ? "+" : ""}${(row.delta * 100).toFixed(2)} pp`}</td></tr>)}<tr><th scope="row">False auto-matches</th><td>{baseline.counts.falseAutoMatches}</td><td>{current.counts.falseAutoMatches}</td><td>{current.counts.falseAutoMatches - baseline.counts.falseAutoMatches}</td></tr></tbody></table></div><p className="metric-note">Deltas are not automatic winner labels. Lower review work is useful only while error controls remain acceptable.</p>{catalog.relatedBenchmarks.map((benchmark) => <aside className="related-benchmark" aria-label="Related frozen benchmark" key={benchmark.id}><div><h3>{benchmark.title}</h3><p>{benchmark.fixtureName} · {benchmark.candidateEngineVersion} · {benchmark.evaluationVersion}</p></div><div><strong>{percent(benchmark.candidateRecall.value)}</strong><span>candidate recall · {benchmark.candidateRecall.numerator} / {benchmark.candidateRecall.denominator}</span><strong>{percent(benchmark.weakIdentifierRecall.value)}</strong><span>weak-identifier recall · {benchmark.weakIdentifierRecall.numerator} / {benchmark.weakIdentifierRecall.denominator}</span></div><p>{benchmark.caveat}</p></aside>)}</section>}

      {view === "thresholds" && <section aria-labelledby="threshold-analysis-title"><header className="view-heading"><div><h2 id="threshold-analysis-title">Threshold analysis</h2><p>Observed match rates describe this fixture only. Scores are bounded evidence scores, not calibrated probabilities.</p></div></header><section aria-labelledby="bands-title"><h3 id="bands-title">Empirical score bands</h3><div className="table-scroll"><table><thead><tr><th scope="col">Score interval</th><th scope="col">Candidates</th><th scope="col">True</th><th scope="col">False</th><th scope="col">Empirical match rate</th></tr></thead><tbody>{current.scoreBands.map((band) => <tr key={band.band}><th scope="row">{band.band}</th><td>{band.candidateCount}</td><td>{band.trueMatchCount}</td><td>{band.falseMatchCount}</td><td>{percent(band.empiricalMatchRate)}</td></tr>)}</tbody></table></div></section>{thresholdRow && <section className="threshold-control" aria-labelledby="threshold-title"><h3 id="threshold-title">Threshold what-if</h3><label>Auto-match threshold <select value={threshold} onChange={(event) => setThreshold(Number(event.target.value))}>{current.thresholdAnalysis.map((row) => <option value={row.threshold} key={row.threshold}>{row.threshold.toFixed(2)}</option>)}</select></label><div className="threshold-stats"><span><strong>{thresholdRow.autoMatchCount}</strong> auto matches</span><span><strong>{percent(thresholdRow.autoMatchPrecision)}</strong> auto precision</span><span><strong>{percent(thresholdRow.autoMatchRecall)}</strong> auto recall</span><span><strong>{percent(thresholdRow.reviewRate)}</strong> review rate</span><span><strong>{thresholdRow.falseAutoMatches}</strong> false auto matches</span></div><p className="warning-copy">Analysis only. Margin, collision, contradiction, and agreement rules remain applied. This control cannot change production matcher configuration.</p></section>}</section>}

      {view === "errors" && <section aria-labelledby="errors-title"><header className="view-heading"><div><h2 id="errors-title">Failure evidence</h2><p>Choose a category, then inspect one case at a time.</p></div></header><div className="error-tabs" role="tablist" aria-label="Evaluation error groups">{ERROR_GROUPS.map(([id, label]) => <button role="tab" aria-selected={group === id} key={id} onClick={() => setGroup(id)}>{label} <span>{current.errorSummary[id] ?? 0}</span></button>)}</div><div aria-live="polite">{errorPage?.group === group ? errorPage.items.length ? <div className="error-inspector"><div className="error-list" aria-label="Error cases">{errorPage.items.map((error) => <button aria-pressed={selectedError?.id === error.id} key={error.id} onClick={() => setSelectedErrorId(error.id)}><strong>{error.aRowId} ↔ {error.bRowId}</strong><span>{displayLabel(error.category)}</span></button>)}</div>{selectedError && <ErrorCard error={selectedError} />}</div> : <p className="empty">No errors in this group.</p> : <p>Loading error evidence…</p>}</div>{errorPage?.group === group && <p className="metric-note">Showing {errorPage.items.length} of {errorPage.total}; API pages are capped at 100 records.</p>}</section>}

      {view === "human" && <section className="human-evidence" aria-labelledby="human-title"><header className="view-heading"><div><h2 id="human-title">Human labels</h2><p>Review decisions remain separate from synthetic ground truth.</p></div></header><div className="reviewed-caveat" role="note"><strong>Reviewed subset · not representative</strong><p>{human?.source.caveat ?? "These labels come from cases selected for review and may not represent the full dataset distribution."}</p></div><div className="threshold-stats"><span><strong>{human?.labeledCandidateCount ?? 0}</strong> decisions collected</span><span><strong>{human?.sameLabels ?? 0}</strong> SAME</span><span><strong>{human?.differentLabels ?? 0}</strong> DIFFERENT</span><span><strong>{percent(human?.systemProposalAgreementRate ?? null)}</strong> agreement on eligible system proposals</span></div><p>Evidence retains the score, shown features, decision time, original matcher version, and candidate-engine version. Retrospective replay must preserve those original fields.</p></section>}
    </div>
  </section>;
}
