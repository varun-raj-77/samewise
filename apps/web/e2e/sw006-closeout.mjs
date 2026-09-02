import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const runtimeModules = process.env.SAMEWISE_RUNTIME_NODE_MODULES;
assert(runtimeModules, "Set SAMEWISE_RUNTIME_NODE_MODULES to bundled Playwright modules.");
const require = createRequire(import.meta.url);
const entry = require.resolve("playwright", { paths: [runtimeModules] });
const imported = await import(pathToFileURL(entry).href);
const { chromium } = imported.default ?? imported;

const fixtureRoot = resolve(root, "fixtures/corrupted/organizations/organizations-dev-v1");
const sourceA = join(fixtureRoot, "dataset_a.csv");
const sourceB = join(fixtureRoot, "dataset_b.csv");
const artifactRoot = resolve(root, "evaluation/reports/sw-006/walkthrough");
await mkdir(artifactRoot, { recursive: true });
const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const before = [await digest(sourceA), await digest(sourceB)];

const mappings = [
  ["Organization", "vendor_name", "organization", "identity", "text"],
  ["Phone", "phone", "telephone", "identity", "phone"],
  ["Email", "contact_email", "email_address", "identity", "email"],
  ["Street", "street", "address_line_1", "identity", "text"],
  ["City", "city", "locality", "identity", "text"],
  ["State", "state", "region", "identity", "text"],
  ["Postal code", "zip", "postal_code", "identity", "text"],
  ["Website", "website", "domain", "identity", "text"],
  ["Status", "account_status", "status", "comparison", "text"],
  ["Balance", "balance", "outstanding_balance", "comparison", "number"],
  ["Updated at", "updated_at", "last_updated", "comparison", "date"],
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const report = { fixture: "organizations-dev-v1", checks: [] };
const check = (name, value = true) => { assert(value, name); report.checks.push(name); };

try {
  await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Start with two messy CSV files." }).waitFor();
  check("real UI created a process-local run");
  await page.getByLabel("Dataset A CSV").setInputFiles(sourceA);
  await page.getByLabel("Dataset B CSV").setInputFiles(sourceB);
  const uploaded = page
    .waitForResponse((response) => response.request().method() === "POST" && /\/datasets\/B$/.test(response.url()))
    .then((response) => ({ status: response.status(), url: response.url() }));
  await page.getByRole("button", { name: "Upload & profile" }).click();
  const { status: uploadStatus, url: uploadUrl } = await uploaded;
  report.runId = new URL(uploadUrl).pathname.split("/")[3];
  await page.getByRole("heading", { name: "Know what arrived." }).waitFor();
  const uploadPayload = await (await fetch(`http://127.0.0.1:3000/api/runs/${report.runId}`)).json();
  check("both immutable CSVs were profiled", uploadStatus === 201 && uploadPayload.datasets.A.rowCount === 23 && uploadPayload.datasets.B.rowCount === 22);

  await page.getByRole("button", { name: "Map corresponding fields" }).click();
  for (let index = 0; index < mappings.length; index += 1) {
    await page.getByRole("button", { name: "+ Add manual mapping" }).click();
  }
  const rows = page.locator(".mapping-row");
  for (let index = 0; index < mappings.length; index += 1) {
    const [label, aColumn, bColumn, role, normalizer] = mappings[index];
    const row = rows.nth(index);
    await row.getByLabel("Mapping label").fill(label);
    await row.getByLabel("Dataset A column").selectOption(aColumn);
    await row.getByLabel("Dataset B column").selectOption(bColumn);
    await row.getByLabel("Mapping role").selectOption(role);
    await row.getByLabel("Normalizer").selectOption(normalizer);
  }
  check("only eight confirmed identity mappings will score", await page.locator(".mapping-row.identity").count() === 8);
  check("three comparison mappings remain post-identity", await page.locator(".mapping-row.comparison").count() === 3);

  const matched = page.waitForResponse((response) => response.request().method() === "POST" && /\/match$/.test(response.url()));
  await page.getByRole("button", { name: "Save confirmed mappings & run matcher" }).click();
  check("candidate generation and matcher completed through the API", (await matched).status() === 200);
  const runResponse = await fetch(`http://127.0.0.1:3000/api/runs/${report.runId}`);
  const run = await runResponse.json();
  report.summary = run.summary;
  check("frozen matcher provenance is retained", run.mappingVersion === "confirmed-mappings-v1" && run.matcherProvenance.matcherVersion === "explainable-matcher-v0.2.0" && run.matcherProvenance.candidateEngineVersion === "candidate-engine-v0.2.0" && run.matcherProvenance.featurePipelineVersion === "feature-pipeline-v0.1.0" && run.matcherProvenance.matcherConfig.frozen === true);
  check("dev result bands are factual", run.summary.matched === 11 && run.summary.needsReview === 8 && run.summary.onlyA === 4 && run.summary.onlyB === 11);
  check("an obvious multi-field proposal exists", run.candidates.some((candidate) => candidate.rank === 1 && candidate.band === "auto_match" && candidate.matchScore >= 0.8));
  check("a visible missing-field case exists", run.candidates.some((candidate) => candidate.evidence.some((item) => item.evidenceClass.startsWith("missing_"))));
  check("a visible contradiction case exists", run.candidates.some((candidate) => candidate.strongContradiction));

  const selected = run.candidates.find((candidate) => candidate.rank === 1 && candidate.band === "needs_review" && run.candidates.some((other) => other.aRowId === candidate.aRowId && other.rank === 2) && mappings.slice(8).some(([, aColumn, bColumn]) => candidate.aRecord[aColumn] !== candidate.bRecord[bColumn]));
  assert(selected, "Expected an ambiguous review candidate with an alternate and comparison conflict.");
  const alternate = run.candidates.find((candidate) => candidate.aRowId === selected.aRowId && candidate.rank === 2);
  report.selectedCandidate = { candidateId: selected.candidateId, aRowId: selected.aRowId, bRowId: selected.bRowId, alternateBRowId: alternate.bRowId };
  await page.screenshot({ path: join(artifactRoot, "sw006-results.png"), fullPage: true });
  await page.getByRole("button", { name: new RegExp(`${selected.aRowId}.*${selected.bRowId}`) }).click();
  check("review shows deterministic candidate provenance", await page.getByText("Why this became a candidate").isVisible() && await page.getByText(/name token|name character|location name|address name/).first().isVisible());
  check("review shows real feature evidence", await page.getByRole("heading", { name: "Mapped identity evidence" }).isVisible() && await page.getByText(/Match score/).isVisible() && await page.getByText(/token similarity|normalized exact/).first().isVisible());
  check("review presents score as match score, not probability", await page.getByText(/Match score/).isVisible() && await page.getByText(/probability/i).count() === 0);
  await page.screenshot({ path: join(artifactRoot, "sw006-review-evidence.png"), fullPage: true });

  const decision = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/candidates/${selected.candidateId}/decisions`));
  await page.getByRole("button", { name: "Same entity" }).click();
  const decided = await (await decision).json();
  const conflicts = decided.conflicts.filter((conflict) => conflict.candidateId === selected.candidateId);
  check("SAME records a separate human identity decision", decided.decisions.some((item) => item.candidateId === selected.candidateId && item.humanDecision === "same_entity"));
  check("comparison conflicts appear only after SAME", conflicts.length > 0);
  check("SAME creates zero automatic survivorship resolutions", conflicts.every((conflict) => conflict.resolution === null));
  await page.screenshot({ path: join(artifactRoot, "sw006-post-identity-conflicts.png"), fullPage: true });

  check("source fixtures remained immutable", JSON.stringify([await digest(sourceA), await digest(sourceB)]) === JSON.stringify(before));
  report.status = "PASS";
  report.screenshots = ["sw006-results.png", "sw006-review-evidence.png", "sw006-post-identity-conflicts.png"];
  await writeFile(join(artifactRoot, "sw006-closeout.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
