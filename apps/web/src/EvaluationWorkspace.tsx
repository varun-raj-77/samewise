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
import { useEffect, useMemo, useState } from "react";

import "./evaluation-workspace.css";

const ERROR_GROUPS = [
  ["candidate_misses", "Candidate misses"],
  ["ranking_losses", "Ranking errors"],
  ["post_score_losses", "Post-score losses"],
  ["false_auto_matches", "False auto-matches"],
  ["false_unmatched", "False unmatched"],
  ["hard_negatives", "Hard negatives"],
] as const;

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

function metric(snapshot: EvaluationCatalog["snapshots"][number], id: string): EvaluationMetric {
  const found = snapshot.metrics.find((item) => item.id === id);
  if (!found) throw new Error(`Missing evaluation metric: ${id}`);
  return found;
}

function MetricCard({ item, primary = false }: { item: EvaluationMetric; primary?: boolean }) {
  return <article className={primary ? "evaluation-metric primary" : "evaluation-metric"}>
    <small>{item.level === "a_row" ? "A-row level" : item.level === "pair" ? "Pair level" : "Search space"}</small>
    <strong>{percent(item.value)}</strong>
    <h3>{item.label}</h3>
    <p>{item.numerator.toLocaleString()} / {item.denominator.toLocaleString()}</p>
    <details><summary>Denominator and definition</summary><p>{item.description}</p></details>
  </article>;
}

function EvidenceList({ record }: { record: Record<string, string> }) {
  return <dl>{Object.entries(record).slice(0, 8).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value || "—"}</dd></div>)}</dl>;
}

function ErrorCard({ error }: { error: EvaluationError }) {
  const details = error as EvaluationError & { failureStage?: string; failureReason?: string; score?: number; rank?: number; autoMatched?: boolean };
  return <article className="evaluation-error-card">
    <header><div><small>{details.failureStage?.replaceAll("_", " ") ?? error.group.replaceAll("_", " ")}</small><h3>{error.aRowId} ↔ {error.bRowId}</h3></div><span>{error.category.replaceAll("_", " ")}</span></header>
    <div className="truth-boundary" role="note"><strong>Evaluation-only truth · {error.evaluationOnlyTruth.label}</strong><p>{error.evaluationOnlyTruth.notice}</p></div>
    <div className="record-pair"><section><h4>Visible A record</h4><EvidenceList record={error.aRecord} /></section><section><h4>Visible B record</h4><EvidenceList record={error.bRecord} /></section></div>
    <p>{details.failureReason}</p>
    {(details.score !== undefined || details.rank !== undefined) && <p className="error-facts">Evidence score {details.score?.toFixed(3) ?? "—"} · rank {details.rank ?? "—"}{details.autoMatched !== undefined ? ` · auto-matched: ${details.autoMatched ? "yes" : "no"}` : ""}</p>}
  </article>;
}

export function EvaluationWorkspace({ runId, initialCatalog, initialHumanEvidence, initialErrorPage, onBack }: EvaluationWorkspaceProps) {
  const [catalog, setCatalog] = useState<EvaluationCatalog | null>(initialCatalog ?? null);
  const [human, setHuman] = useState<HumanReviewEvidence | null>(initialHumanEvidence ?? null);
  const [group, setGroup] = useState<EvaluationErrorPage["group"]>(initialErrorPage?.group ?? "candidate_misses");
  const [errorPage, setErrorPage] = useState<EvaluationErrorPage | null>(initialErrorPage ?? null);
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
    if (!current || initialErrorPage?.group === group) return;
    setErrorPage(null);
    void fetch(`/api/evaluations/${encodeURIComponent(current.id)}/errors?type=${group}&offset=0&limit=20`)
      .then(json).then((value) => setErrorPage(EvaluationErrorPageSchema.parse(value))).catch((error: Error) => setNotice(error.message));
  }, [current, group, initialErrorPage]);

  if (!catalog || !current || !baseline || !comparison) return <section className="evaluation-loading" aria-live="polite"><button className="secondary" onClick={onBack}>Back to reconciliation</button><p>{notice ?? "Loading versioned evaluation evidence…"}</p></section>;
  const thresholdRow = current.thresholdAnalysis.find((row) => row.threshold === threshold) ?? current.thresholdAnalysis[0];
  const primary = ["candidate_recall", "auto_match_precision", "review_rate", "end_to_end_recovery"].map((id) => metric(current, id));
  const secondary = ["top1_true_candidate_rate", "candidate_reduction_ratio"].map((id) => metric(current, id));

  return <section className="evaluation-workspace" aria-labelledby="evaluation-title">
    <div className="evaluation-heading"><div><p className="eyebrow">Evaluation product · frozen evidence</p><h1 id="evaluation-title">What changed between matcher versions?</h1><p className="lede">Stage-by-stage evidence, compatible comparisons, and inspectable failures. No aggregate full-dataset claim.</p></div><button className="secondary" onClick={onBack}>Back to reconciliation</button></div>

    <section className="evaluation-identity" aria-labelledby="evaluated-title"><div><span className="source-chip">{current.source.type.replaceAll("_", " ")}</span><h2 id="evaluated-title">{current.fixture.name}</h2><p>{current.source.caveat}</p></div><dl><div><dt>Dataset size</dt><dd>{current.fixture.aRows.toLocaleString()} A · {current.fixture.bRows.toLocaleString()} B</dd></div><div><dt>Matcher</dt><dd>{current.provenance.matcherVersion}</dd></div><div><dt>Candidate engine</dt><dd>{current.provenance.candidateEngineVersion}</dd></div><div><dt>Evaluation</dt><dd>{current.evaluationVersion}</dd></div><div><dt>Snapshot hash</dt><dd>{current.contentHash.slice(0, 12)}</dd></div></dl></section>

    {catalog.relatedBenchmarks.map((benchmark) => <aside className="related-benchmark" aria-label="Related frozen benchmark" key={benchmark.id}><div><p className="eyebrow">Related candidate-stage evidence</p><h2>{benchmark.title}</h2><p>{benchmark.fixtureName} · {benchmark.candidateEngineVersion} · {benchmark.evaluationVersion}</p></div><div><strong>{percent(benchmark.candidateRecall.value)}</strong><span>candidate recall · {benchmark.candidateRecall.numerator} / {benchmark.candidateRecall.denominator}</span><strong>{percent(benchmark.weakIdentifierRecall.value)}</strong><span>weak-identifier recall · {benchmark.weakIdentifierRecall.numerator} / {benchmark.weakIdentifierRecall.denominator}</span></div><p>{benchmark.caveat}</p></aside>)}

    <section aria-labelledby="stage-metrics-title"><p className="eyebrow">Stage metrics</p><h2 id="stage-metrics-title">Quality at each boundary</h2><div className="evaluation-metric-grid">{primary.map((item) => <MetricCard key={item.id} item={item} primary />)}{secondary.map((item) => <MetricCard key={item.id} item={item} />)}<article className="evaluation-metric"><small>Pair count</small><strong>{current.counts.falseAutoMatches}</strong><h3>False auto-matches</h3><p>Automatically accepted pairs false in fixture truth</p></article><article className="evaluation-metric"><small>Adversarial pair count</small><strong>{current.counts.hardNegativeAutoMatches}</strong><h3>Hard-negative auto-matches</h3><p>Known similar-but-different pairs auto-linked</p></article></div></section>

    <section className="pipeline-section" aria-labelledby="pipeline-title"><p className="eyebrow">Pair-level pipeline</p><h2 id="pipeline-title">Where true links were lost</h2><ol className="evaluation-pipeline"><li><strong>{current.decomposition.pairLevel.trueLinks}</strong><span>True cross-source links</span></li><li><strong>{current.decomposition.pairLevel.candidateRetained}</strong><span>Reached candidate set</span></li><li><strong>{current.decomposition.pairLevel.featureScored}</strong><span>Feature scored</span></li><li><strong>{current.decomposition.pairLevel.recoverable}</strong><span>Retained / recoverable</span></li><li><strong>{current.decomposition.pairLevel.autoMatched}</strong><span>Auto matched; remaining eligible rows go to review</span></li></ol><p className="metric-note">Pair-level links are distinct from the {current.decomposition.aRowLevel.matchable} matchable A-row denominator used by review rate.</p></section>

    <section aria-labelledby="gates-title"><div className="section-heading"><div><p className="eyebrow">Versioned policy · {current.gateResult.configVersion}</p><h2 id="gates-title">Regression gates</h2></div><span className={current.gateResult.passed ? "compatibility compatible" : "compatibility"}>{current.gateResult.passed ? "All current gates passed" : "Current gates failed"}</span></div><ul className="gate-list">{current.gateResult.checks.map((check) => <li key={check.id}><strong>{check.passed ? "PASS" : "FAIL"}</strong><span>{check.id.replaceAll("_", " ")}</span><small>actual {check.actual ?? "undefined"} · policy {check.expected}</small></li>)}</ul><p className="metric-note">Baseline status under the current accepted policy: <strong>{baseline.gateResult.passed ? "passed" : "failed"}</strong>. Gate results are evidence, not an automatic overall winner.</p></section>

    <section aria-labelledby="comparison-title"><div className="section-heading"><div><p className="eyebrow">Same frozen holdout</p><h2 id="comparison-title">Version comparison</h2></div><span className={comparison.compatible ? "compatibility compatible" : "compatibility"}>{comparison.status}</span></div>{comparison.reasons.length > 0 && <ul>{comparison.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}<div className="table-scroll"><table><caption>Baseline matcher compared with explainable matcher v0.2 on compatible evidence</caption><thead><tr><th scope="col">Metric</th><th scope="col">{baseline.provenance.matcherVersion}</th><th scope="col">{current.provenance.matcherVersion}</th><th scope="col">Delta</th></tr></thead><tbody>{comparison.metrics.filter((row) => ["auto_match_precision", "review_rate", "top1_true_candidate_rate", "candidate_recall", "end_to_end_recovery"].includes(row.metricId)).map((row) => <tr key={row.metricId}><th scope="row">{row.label}</th><td>{percent(row.versionA)}</td><td>{percent(row.versionB)}</td><td>{row.delta === null ? "—" : `${row.delta >= 0 ? "+" : ""}${(row.delta * 100).toFixed(2)} pp`}</td></tr>)}<tr><th scope="row">False auto-matches</th><td>{baseline.counts.falseAutoMatches}</td><td>{current.counts.falseAutoMatches}</td><td>{current.counts.falseAutoMatches - baseline.counts.falseAutoMatches}</td></tr></tbody></table></div><p className="metric-note">Deltas are not automatic winner labels. Lower review work is useful only while error controls remain acceptable.</p></section>

    <section aria-labelledby="bands-title"><p className="eyebrow">Frozen score evidence</p><h2 id="bands-title">Empirical score bands</h2><p>Observed match rates describe this fixture only. Match scores remain bounded evidence scores.</p><div className="table-scroll"><table><thead><tr><th scope="col">Score interval</th><th scope="col">Candidates</th><th scope="col">True</th><th scope="col">False</th><th scope="col">Empirical match rate</th></tr></thead><tbody>{current.scoreBands.map((band) => <tr key={band.band}><th scope="row">{band.band}</th><td>{band.candidateCount}</td><td>{band.trueMatchCount}</td><td>{band.falseMatchCount}</td><td>{percent(band.empiricalMatchRate)}</td></tr>)}</tbody></table></div></section>

    {thresholdRow && <section aria-labelledby="threshold-title"><p className="eyebrow">Retrospective analysis</p><h2 id="threshold-title">Threshold what-if</h2><label>Auto-match threshold <select value={threshold} onChange={(event) => setThreshold(Number(event.target.value))}>{current.thresholdAnalysis.map((row) => <option value={row.threshold} key={row.threshold}>{row.threshold.toFixed(2)}</option>)}</select></label><div className="threshold-stats"><span><strong>{thresholdRow.autoMatchCount}</strong> auto matches</span><span><strong>{percent(thresholdRow.autoMatchPrecision)}</strong> auto precision</span><span><strong>{percent(thresholdRow.autoMatchRecall)}</strong> auto recall</span><span><strong>{percent(thresholdRow.reviewRate)}</strong> review rate</span><span><strong>{thresholdRow.falseAutoMatches}</strong> false auto matches</span></div><p className="warning-copy">Analysis only. Margin, collision, contradiction, and agreement rules remain applied. This control cannot change production matcher configuration.</p></section>}

    <section aria-labelledby="errors-title"><p className="eyebrow">Failure inspection</p><h2 id="errors-title">Errors lead to examples</h2><div className="error-tabs" role="tablist" aria-label="Evaluation error groups">{ERROR_GROUPS.map(([id, label]) => <button role="tab" aria-selected={group === id} key={id} onClick={() => setGroup(id)}>{label} <span>{current.errorSummary[id] ?? 0}</span></button>)}</div><div aria-live="polite">{errorPage?.group === group ? errorPage.items.length ? <>{errorPage.items.map((error) => <ErrorCard error={error} key={error.id} />)}<p>Showing {errorPage.items.length} of {errorPage.total}; API pages are capped at 100 records.</p></> : <p className="empty">No errors in this group.</p> : <p>Loading error evidence…</p>}</div></section>

    <section className="human-evidence" aria-labelledby="human-title"><p className="eyebrow">Separate source type</p><h2 id="human-title">Human Review Evidence</h2><div className="reviewed-caveat" role="note"><strong>Reviewed subset · not representative</strong><p>{human?.source.caveat ?? "These labels come from cases selected for review and may not represent the full dataset distribution."}</p></div><div className="threshold-stats"><span><strong>{human?.labeledCandidateCount ?? 0}</strong> decisions collected</span><span><strong>{human?.sameLabels ?? 0}</strong> SAME</span><span><strong>{human?.differentLabels ?? 0}</strong> DIFFERENT</span><span><strong>{percent(human?.systemProposalAgreementRate ?? null)}</strong> agreement on eligible system proposals</span></div><p>Evidence retains the score, shown features, decision time, original matcher version, and candidate-engine version. Retrospective replay must preserve those original fields.</p></section>
  </section>;
}
