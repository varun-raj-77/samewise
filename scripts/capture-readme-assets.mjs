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
  ["Organization", "vendor_name", "organization", "name_or_title", "text", true],
  ["Phone", "phone", "telephone", "phone", "phone", true],
  ["Email", "contact_email", "email_address", "email", "email", true],
  ["Street", "street", "address_line_1", "address", "text", true],
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
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
  const reviewSearch = page.getByRole("searchbox", { name: "Search review queue" });
  await reviewSearch.fill("A000020");
  await page.getByTestId("review-queue-row").filter({ hasText: "A000020" }).click();
  await reviewSearch.fill("");
  await page.getByRole("heading", { name: /Could A000020 and .* be the same entity/ }).waitFor();
  await page.locator(".case-heading").waitFor();
  assert(await page.locator(".evidence-hierarchy .negative").isVisible(), "Hero case should visibly explain contradictory or competing evidence.");
  assert(await page.locator(".collision-warning").isVisible(), "Hero case should retain competing-candidate context.");
  await page.getByRole("button", { name: "Different entities" }).waitFor();
  await page.getByRole("button", { name: "Same entity", exact: true }).waitFor();
  for (const name of ["Different entities", "Same entity"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    assert(box && box.y >= 0 && box.y + box.height <= 1100, `${name} action is outside the hero viewport.`);
  }
  await shot("review-case.png");

  // A modest deterministic presentation fixture provides representative merge
  // and export state without loading evaluation truth or using a scale fixture.
  const clean = await request("/runs", { method: "POST" });
  const cleanId = clean.runId;
  const aRows = ["id,name,phone,status,balance,city"];
  const bRows = ["id,organization,telephone,status,balance,city"];
  for (let index = 1; index <= 24; index += 1) {
    const code = String(index).padStart(2, "0");
    aRows.push(`A${code},Harbor Works ${code},55501${code},${index % 2 === 0 ? "Active" : "Pending"},${1000 + index * 25},${index % 3 === 0 ? "Albany" : "Buffalo"}`);
  }
  for (let index = 1; index <= 20; index += 1) {
    const code = String(index).padStart(2, "0");
    bRows.push(`B${code},Harbor Works ${code},55501${code},${index % 2 === 0 ? "Current" : "Pending"},${1000 + index * 25 + (index % 3 === 0 ? 10 : 0)},${index % 4 === 0 ? "Rochester" : index % 3 === 0 ? "Albany" : "Buffalo"}`);
  }
  for (let index = 21; index <= 24; index += 1) {
    const code = String(index).padStart(2, "0");
    bRows.push(`B${code},Summit Supply ${code},55509${code},Current,${2000 + index * 20},Syracuse`);
  }
  const a = aRows.join("\n") + "\n";
  const b = bRows.join("\n") + "\n";
  for (const [side, csv] of [["A", a], ["B", b]]) {
    await request(`/runs/${cleanId}/datasets/${side}`, {
      method: "POST", headers: { "Content-Type": "text/csv", "X-File-Name": `readme-clean-${side}.csv` }, body: csv,
    });
  }
  const cleanMappings = [
    ["Name", "name", "organization", "name_or_title", "text", true],
    ["Phone", "phone", "telephone", "phone", "phone", true],
    ["Status", "status", "status", "categorical", "text", false],
    ["Balance", "balance", "balance", "numeric", "number", false],
    ["City", "city", "city", "geography", "text", false],
  ].map(([label, aColumn, bColumn, semanticFamily, normalizer, useForMatching], index) => ({
    mappingId: `readme-clean-${index}`, label, aColumn, bColumn, semanticFamily,
    normalizer, useForMatching, includeInMerge: true,
  }));
  await request(`/runs/${cleanId}/mappings`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mappings: cleanMappings }),
  });
  const cleanMatch = await request(`/runs/${cleanId}/match`, { method: "POST" });
  assert(cleanMatch.reviewProgress.remaining === 0, "Clean presentation fixture unexpectedly needs identity review.");
  assert.equal(cleanMatch.summary.matched, 20, "Presentation fixture should produce 20 automatic matches.");
  assert(cleanMatch.conflictSummary.total >= 20, "Presentation fixture should produce several field differences.");
  await page.goto(`http://localhost:5173/?run=${cleanId}&screen=resolution`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Choose which values to keep." }).waitFor();
  await page.getByRole("combobox", { name: "Rule for Status" }).selectOption("prefer_trusted_source");
  await page.getByRole("combobox", { name: "Rule for Balance" }).selectOption("prefer_trusted_source");
  await page.getByRole("combobox", { name: "Rule for City" }).selectOption("prefer_trusted_source");
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
  process.stdout.write(JSON.stringify({
    output,
    heroRun: runId,
    presentationRun: cleanId,
    presentationState: {
      rowsA: 24,
      rowsB: 24,
      overlappingEntities: 20,
      automaticMatches: cleanMatch.summary.matched,
      fieldDifferences: cleanMatch.conflictSummary.total,
    },
    images: ["review-case.png", "merge-values.png", "export-ready.png"],
  }) + "\n");
} finally {
  await browser.close();
}
