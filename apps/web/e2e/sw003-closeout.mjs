import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const runtimeModules = process.env.SAMEWISE_RUNTIME_NODE_MODULES;
assert(runtimeModules, "Set SAMEWISE_RUNTIME_NODE_MODULES to a node_modules directory containing Playwright.");
const require = createRequire(import.meta.url);
const playwrightEntry = require.resolve("playwright", { paths: [runtimeModules] });
const playwrightModule = await import(pathToFileURL(playwrightEntry).href);
const { chromium } = playwrightModule.default ?? playwrightModule;

const fixtureRoot = resolve(root, "fixtures/corrupted/organizations/organizations-dev-v1");
const sourceA = join(fixtureRoot, "dataset_a.csv");
const sourceB = join(fixtureRoot, "dataset_b.csv");
const artifactRoot = resolve(root, ".samewise-data/acceptance");
await mkdir(artifactRoot, { recursive: true });

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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const browser = await chromium.launch({ headless: process.env.SAMEWISE_HEADLESS === "1", slowMo: 35 });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
const report = { fixture: "organizations-dev-v1", checks: [], runId: null, summary: null };
const check = (name, value = true) => { assert(value, name); report.checks.push(name); };

try {
  const createResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/runs$/.test(response.url()));
  await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
  check("real UI created a run through the API", (await createResponse).status() === 201);

  await page.getByLabel("Dataset A CSV").setInputFiles(sourceA);
  await page.getByLabel("Dataset B CSV").setInputFiles(sourceB);
  const profileRequest = page.waitForRequest((request) => request.method() === "POST" && /\/datasets\/B$/.test(request.url()));
  const profileResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/datasets\/B$/.test(response.url()));
  await page.getByRole("button", { name: "Upload & profile" }).click();
  const uploadedTo = await profileRequest;
  report.runId = new URL(uploadedTo.url()).pathname.split("/")[3];
  check("active UI run ID is observable", typeof report.runId === "string" && report.runId.startsWith("run-"));
  check("both fixtures were profiled through the API", (await profileResponse).status() === 201);
  const readRun = async () => {
    const response = await fetch(`http://127.0.0.1:3000/api/runs/${report.runId}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const profiled = await readRun();
  await page.getByRole("heading", { name: "Know what arrived." }).waitFor();
  check("fixture filenames are visible", await page.getByText("dataset_a.csv").isVisible() && await page.getByText("dataset_b.csv").isVisible());
  check("profile dimensions are real", profiled.datasets.A.rowCount === 23 && profiled.datasets.B.rowCount === 22 && profiled.datasets.A.columns.length === 12 && profiled.datasets.B.columns.length === 12);
  check("profile metadata is visible", await page.getByText(/23 rows · SHA-256/).isVisible() && await page.getByText(/22 rows · SHA-256/).isVisible());

  await page.getByRole("button", { name: "Map corresponding fields" }).click();
  for (let index = 0; index < mappings.length; index += 1) await page.getByRole("button", { name: "+ Add mapping" }).click();
  const rows = page.locator(".mapping-row");
  check("eleven manual mappings are visible", await rows.count() === mappings.length);
  for (let index = 0; index < mappings.length; index += 1) {
    const [label, aColumn, bColumn, role, normalizer] = mappings[index];
    const row = rows.nth(index);
    await row.getByLabel("Mapping label").fill(label);
    await row.getByLabel("Dataset A column").selectOption(aColumn);
    await row.getByLabel("Dataset B column").selectOption(bColumn);
    await row.getByLabel("Mapping role").selectOption(role);
    await row.getByLabel("Normalizer").selectOption(normalizer);
  }
  check("identity and comparison roles are visibly distinct", await page.locator(".mapping-row.comparison").count() === 3);

  const matchResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/match$/.test(response.url()));
  await page.getByRole("button", { name: "Save mappings & run baseline" }).click();
  check("baseline match completed through the API", (await matchResponse).status() === 200);
  let run = await readRun();
  await page.getByRole("heading", { name: "A transparent first pass." }).waitFor();
  report.summary = run.summary;
  check("result categories are visible", await page.getByText("Matched", { exact: true }).isVisible() && await page.getByText("Needs review", { exact: true }).isVisible() && await page.getByText("Only A", { exact: true }).isVisible() && await page.getByText("Only B", { exact: true }).isVisible());
  check("result counts come from the live matcher", run.summary.matched === 10 && run.summary.needsReview === 11 && run.summary.onlyA === 2 && run.summary.onlyB === 12);
  check("Only B semantics are explained", await page.getByText(/Only B means no identity link is established/).isVisible());

  await page.getByRole("button", { name: /A000001.*B000013/ }).click();
  check("identity evidence is visible", await page.getByRole("heading", { name: "Evidence shown" }).isVisible() && await page.getByText(/Baseline score/).isVisible());
  const selectedId = "candidate-1-13";
  const sameResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/candidates/${selectedId}/decisions`));
  await page.getByRole("button", { name: "Same entity" }).click();
  check("SAME was recorded through the API", (await sameResponse).status() === 200);
  run = await readRun();
  const selectedConflicts = run.conflicts.filter((conflict) => conflict.candidateId === selectedId);
  check("SAME created selected-pair field conflicts", selectedConflicts.length === 3);
  check("SAME made zero automatic survivorship choices", selectedConflicts.every((conflict) => conflict.resolution === null));
  await page.getByRole("heading", { name: "Identity is settled. Values are not." }).waitFor();

  const chosenConflict = selectedConflicts[0];
  const chosenConflictIndex = run.conflicts.findIndex((conflict) => conflict.conflictId === chosenConflict.conflictId);
  const chosenCard = page.locator(".conflict-card").nth(chosenConflictIndex);
  check("selected conflict values are visible", await chosenCard.isVisible() && (await chosenCard.innerText()).includes(chosenConflict.aValue) && (await chosenCard.innerText()).includes(chosenConflict.bValue));
  const resolutionResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/conflicts/${chosenConflict.conflictId}/resolutions`));
  await chosenCard.getByRole("button", { name: "Use A" }).click();
  check("field resolution completed through the API", (await resolutionResponse).status() === 200);
  run = await readRun();
  check("one explicit field resolution was recorded", run.conflicts.find((conflict) => conflict.conflictId === chosenConflict.conflictId)?.resolution?.action === "use_a");
  check("other selected fields remain unresolved", run.conflicts.filter((conflict) => conflict.candidateId === selectedId && conflict.conflictId !== chosenConflict.conflictId).every((conflict) => conflict.resolution === null));

  await page.getByRole("button", { name: "Back to results" }).click();
  const conflictCountBeforeDifferent = run.conflicts.length;
  const nextCandidate = page.locator(".candidate-row").first();
  const nextCandidateText = (await nextCandidate.innerText()).replace(/\s+/g, " ").trim();
  check("another unresolved candidate is visible", !nextCandidateText.includes("A000001"));
  await nextCandidate.click();
  const differentResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/decisions$/.test(response.url()));
  await page.getByRole("button", { name: "Different entity" }).click();
  check("DIFFERENT was recorded through the API", (await differentResponse).status() === 200);
  run = await readRun();
  check("DIFFERENT created no field conflicts", run.conflicts.length === conflictCountBeforeDifferent);

  await page.getByRole("button", { name: "Prepare export" }).click();
  await page.getByRole("heading", { name: "Export without hiding uncertainty." }).waitFor();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download reconciliation CSV" }).click();
  const download = await downloadPromise;
  const exportPath = join(artifactRoot, "sw003-reconciliation.csv");
  await download.saveAs(exportPath);
  const csv = await readFile(exportPath, "utf8");
  check("export has identity provenance headers", csv.includes("identity_decision_source") && csv.includes("matcher_version"));
  check("export retains system and human decision sources", csv.includes("system_baseline") && csv.includes(",human,"));
  check("export retains unresolved markers", csv.includes("unresolved") && csv.includes("pending_identity"));

  const sourceHashes = [sha256(await readFile(sourceA)), sha256(await readFile(sourceB))].sort();
  const uploadedFiles = (await readdir(resolve(root, ".samewise-data", report.runId))).map((name) => resolve(root, ".samewise-data", report.runId, name));
  const uploadedHashes = (await Promise.all(uploadedFiles.map(async (path) => sha256(await readFile(path))))).sort();
  check("uploaded source bytes retain their original hashes", JSON.stringify(uploadedHashes) === JSON.stringify(sourceHashes));
  check("profile hashes match original source bytes", profiled.datasets.A.sha256 === sourceHashes.find((hash) => hash === profiled.datasets.A.sha256) && profiled.datasets.B.sha256 === sourceHashes.find((hash) => hash === profiled.datasets.B.sha256));

  await page.screenshot({ path: join(artifactRoot, "sw003-export.png"), fullPage: true });
  report.exportPath = exportPath;
  report.screenshotPath = join(artifactRoot, "sw003-export.png");
  report.status = "PASS";
  await writeFile(join(artifactRoot, "sw003-closeout.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
