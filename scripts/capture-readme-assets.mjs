// Capture current product screens from visible deterministic fixture inputs.
// Start the API and web dev servers first. Set SAMEWISE_RUNTIME_NODE_MODULES to
// the existing bundled node_modules directory containing Playwright.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const runtimeModules = process.env.SAMEWISE_RUNTIME_NODE_MODULES;
assert(runtimeModules, "Set SAMEWISE_RUNTIME_NODE_MODULES to the existing Playwright module directory.");
const require = createRequire(import.meta.url);
const entry = require.resolve("playwright", { paths: [runtimeModules] });
const imported = await import(pathToFileURL(entry).href);
const { chromium } = imported.default ?? imported;
const output = resolve(root, "docs/assets/readme");
await mkdir(output, { recursive: true });

const api = "http://127.0.0.1:3000/api";
async function request(path, init) {
  const response = await fetch(api + path, init);
  const value = await response.json();
  assert(response.ok, JSON.stringify(value));
  return value;
}
async function upload(runId, side, path) {
  return request(`/runs/${runId}/datasets/${side}`, {
    method: "POST",
    headers: { "Content-Type": "text/csv", "X-File-Name": `readme-${side}.csv` },
    body: await readFile(path),
  });
}
const fixture = resolve(root, "fixtures/corrupted/organizations/organizations-dev-v1");
const created = await request("/runs", { method: "POST" });
const runId = created.runId;
await upload(runId, "A", join(fixture, "dataset_a.csv"));
await upload(runId, "B", join(fixture, "dataset_b.csv"));
const specifications = [
  ["Status", "account_status", "status", "categorical", "text", false],
  ["Organization", "vendor_name", "organization", "name_or_title", "text", true],
  ["Phone", "phone", "telephone", "phone", "phone", true],
  ["Email", "contact_email", "email_address", "email", "email", true],
  ["Street", "street", "address_line_1", "address", "text", true],
  ["City", "city", "locality", "geography", "text", true],
  ["State", "state", "region", "geography", "text", true],
  ["Website", "website", "domain", "domain", "text", true],
  ["Balance", "balance", "outstanding_balance", "numeric", "number", false],
];
const mappings = specifications.map(([label, aColumn, bColumn, semanticFamily, normalizer, useForMatching], index) => ({
  mappingId: `readme-mapping-${index}`, label, aColumn, bColumn, semanticFamily,
  normalizer, useForMatching, includeInMerge: true,
}));
await request(`/runs/${runId}/mappings`, {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mappings }),
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
async function open(screen, heading) {
  await page.goto(`http://localhost:5173/?run=${runId}&screen=${screen}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: heading }).waitFor();
}
async function shot(name) {
  await page.screenshot({ path: join(output, name), fullPage: false, animations: "disabled" });
}
try {
  await open("mapping", "Set up matching.");
  await shot("match-setup.png");

  const matched = await request(`/runs/${runId}/match`, { method: "POST" });
  assert(matched.summary, "Matching did not produce a summary.");
  await open("review", /Matching review|Could these be the same entity/);
  const backToGroups = page.getByRole("button", { name: "Back to grouped review" });
  if (await backToGroups.count()) await backToGroups.click();
  await page.locator(".review-group-card").first().waitFor();
  await page.locator(".review-group-card").first().getByRole("button", { name: "Preview cases" }).click();
  await page.locator(".review-group-preview .group-samples article").first().waitFor();
  await page.locator(".review-group-preview").getByRole("button", { name: "Inspect full evidence" }).first().click();
  await page.getByRole("heading", { name: "Could these be the same entity?" }).waitFor();
  await page.locator(".case-heading").waitFor();
  await shot("review-case.png");

  // A review-state illustration: use the matcher-proposed top candidate for
  // each visible uncertain row only when the UI's group safety gate allows it.
  // A separate clean fixture is used below for merge and export readiness.
  const clean = await request("/runs", { method: "POST" });
  const cleanId = clean.runId;
  const a = "id,name,phone,status\nA1,Northstar Labs,5550100,Active\nA2,Blue Harbor,5550200,Active\n";
  const b = "id,organization,telephone,status\nB1,Northstar Labs,5550100,Current\nB2,Blue Harbor,5550200,Current\n";
  for (const [side, csv] of [["A", a], ["B", b]]) {
    await request(`/runs/${cleanId}/datasets/${side}`, {
      method: "POST", headers: { "Content-Type": "text/csv", "X-File-Name": `readme-clean-${side}.csv` }, body: csv,
    });
  }
  const cleanMappings = [
    ["Name", "name", "organization", "name_or_title", "text", true],
    ["Phone", "phone", "telephone", "phone", "phone", true],
    ["Status", "status", "status", "categorical", "text", false],
  ].map(([label, aColumn, bColumn, semanticFamily, normalizer, useForMatching], index) => ({
    mappingId: `readme-clean-${index}`, label, aColumn, bColumn, semanticFamily,
    normalizer, useForMatching, includeInMerge: true,
  }));
  await request(`/runs/${cleanId}/mappings`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mappings: cleanMappings }),
  });
  const cleanMatch = await request(`/runs/${cleanId}/match`, { method: "POST" });
  assert(cleanMatch.reviewProgress.remaining === 0, "Clean presentation fixture unexpectedly needs identity review.");
  await page.goto(`http://localhost:5173/?run=${cleanId}&screen=resolution`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Choose which values to keep." }).waitFor();
  await page.getByRole("combobox", { name: "Rule for Status" }).selectOption("prefer_trusted_source");
  await page.getByRole("button", { name: "Preview merge plan" }).click();
  await page.getByRole("heading", { name: "Merge plan preview" }).waitFor();
  await shot("merge-values.png");
  await page.getByRole("button", { name: "Apply merge plan" }).click();
  await page.getByRole("button", { name: "Continue to Export" }).waitFor();
  await page.goto(`http://localhost:5173/?run=${cleanId}&screen=export`, { waitUntil: "networkidle" });
  await page.getByText("Ready to export", { exact: true }).waitFor();
  await page.getByText("Audit & technical files").click();
  await shot("export-ready.png");
  assert.deepEqual(errors, [], `Browser errors: ${errors.join("; ")}`);
  process.stdout.write(JSON.stringify({ output, reviewRun: runId, cleanRun: cleanId, images: ["match-setup.png", "review-case.png", "merge-values.png", "export-ready.png"] }) + "\n");
} finally {
  await browser.close();
}
