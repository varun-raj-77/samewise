import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const runtimeModules = process.env.SAMEWISE_RUNTIME_NODE_MODULES;
assert(runtimeModules, "Set SAMEWISE_RUNTIME_NODE_MODULES to bundled Playwright modules.");
const require = createRequire(import.meta.url);
const entry = require.resolve("playwright", { paths: [runtimeModules] });
const imported = await import(pathToFileURL(entry).href);
const { chromium } = imported.default ?? imported;

const sourceA = resolve(root, "apps/web/public/samples/samewise_sample_vendors_a.csv");
const fieldTypes = [
  "source_local_identifier", "persistent_identifier", "name_or_title", "address", "geography", "geography",
  "geography", "email", "phone", "contact_person", "date_or_timestamp",
];
const normalizers = ["text", "text", "text", "text", "text", "text", "text", "email", "phone", "text", "date"];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
const checks = [];
const check = (name, condition = true) => { assert(condition, name); checks.push(name); };

try {
  await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Upload datasets" }).waitFor();

  const uploaded = page.waitForResponse((response) => response.request().method() === "POST" && /\/datasets\/B$/.test(response.url()));
  await page.getByRole("button", { name: "Try sample data" }).click();
  const uploadResponse = await uploaded;
  const runId = new URL(uploadResponse.url()).pathname.split("/")[3];
  await page.getByRole("heading", { name: "Your files are ready." }).waitFor();
  check("one click loaded and profiled both public sample files", uploadResponse.status() === 201);
  check("sample origin is stated truthfully", await page.getByText("Using synthetic sample data.").isVisible());

  await page.getByRole("button", { name: "Set up matching" }).click();
  for (let index = 0; index < fieldTypes.length; index += 1) {
    await page.getByRole("button", { name: "+ Add manual mapping" }).click();
    await page.locator(".mapping-row").nth(index).waitFor();
  }
  const rows = page.locator(".mapping-row");
  check("manual mapping fallback exposes every corresponding sample column", await rows.count() === 11);
  for (let index = 0; index < fieldTypes.length; index += 1) {
    const row = rows.nth(index);
    await row.getByLabel("Field type").selectOption(fieldTypes[index]);
    await row.getByLabel("Normalizer").selectOption(normalizers[index]);
  }
  await rows.nth(0).getByLabel("Use to match").uncheck();
  await rows.nth(0).getByLabel("Keep in result").uncheck();
  await rows.nth(1).getByLabel("Keep in result").uncheck();
  await rows.nth(10).getByLabel("Use to match").uncheck();

  const matched = page.waitForResponse((response) => response.request().method() === "POST" && /\/match$/.test(response.url()));
  await page.getByRole("button", { name: "Confirm setup & run matching" }).click();
  check("the real frozen matcher completed", (await matched).status() === 200);
  await page.getByRole("heading", { name: "Matching complete." }).waitFor();
  const run = await (await fetch(`http://127.0.0.1:3000/api/runs/${runId}`)).json();
  check("fixture outcome is 23 automatic, 1 review, 4 A-only, and 4 B-only", JSON.stringify(run.summary) === JSON.stringify({ matched: 23, needsReview: 1, onlyA: 4, onlyB: 4 }));

  await page.getByRole("button", { name: "Review 1 uncertain match" }).click();
  await page.getByRole("heading", { name: "Could these be the same entity?" }).waitFor();
  await page.getByRole("heading", { name: "Could A-1024 and B-2024 be the same entity?" }).waitFor();
  check("the intuitive Orchard Signal case reached the normal review UI", await page.getByText("Orchard Signal Creative", { exact: true }).first().isVisible());
  await page.getByRole("button", { name: "Same entity" }).click();
  await page.getByRole("button", { name: "Continue to Merge values" }).click();
  await page.getByRole("heading", { name: "Choose which values to keep." }).waitFor();
  check("normal identity decision produced visible merge differences", Number(await page.locator(".survivorship-summary strong").first().textContent()) > 0);

  await page.getByRole("button", { name: "New reconciliation" }).click();
  await page.getByRole("button", { name: "Start new reconciliation" }).click();
  await page.getByRole("heading", { name: "Upload datasets" }).waitFor();
  await page.getByRole("button", { name: "Dataset A CSV", exact: true }).setInputFiles(sourceA);
  await page.getByRole("button", { name: "Try sample data" }).click();
  await page.getByRole("dialog", { name: "Replace your selected files with the sample datasets?" }).waitFor();
  await page.getByRole("button", { name: "Cancel" }).click();
  check("replacement Cancel preserves the manually selected file", await page.getByText("samewise_sample_vendors_a.csv").isVisible());

  console.log(JSON.stringify({ status: "PASS", runId, checks }, null, 2));
} finally {
  await browser.close();
}
