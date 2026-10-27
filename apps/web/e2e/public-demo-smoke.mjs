import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
const context = await browser.newContext({ viewport: { width: 1500, height: 1050 }, acceptDownloads: true });
const page = await context.newPage();
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

  // Complete the same public sample flow with real rule application and all three downloads.
  const fieldRules = page.locator(".merge-field-row select[aria-label^='Rule for ']");
  const fieldCount = await fieldRules.count();
  check("merge rules are offered for the sample's conflicting fields", fieldCount > 0);
  for (let index = 0; index < fieldCount; index += 1) {
    await fieldRules.nth(index).selectOption("keep_both");
  }
  const previewed = page.waitForResponse((response) => response.request().method() === "POST" && /\/merge-plan-preview$/.test(response.url()));
  await page.getByRole("button", { name: "Preview merge plan" }).click();
  const previewResponse = await previewed;
  assert.equal(previewResponse.status(), 200);
  const preview = await previewResponse.json();
  check("preview explicitly handles the differences without dropping values", preview.willHandle > 0 && preview.willRemain === 0 && preview.preservedBoth > 0);

  const applied = page.waitForResponse((response) => response.request().method() === "POST" && /\/merge-plan-apply$/.test(response.url()));
  await page.getByRole("button", { name: "Apply merge plan" }).click();
  check("merge plan applied successfully", (await applied).status() === 200);
  const readyRun = await (await fetch(`http://127.0.0.1:3000/api/runs/${runId}`)).json();
  check("trusted output is ready with no unresolved differences", readyRun.trustedExportReadiness.ready && readyRun.conflictSummary.unresolved === 0);
  await page.getByRole("button", { name: "Continue to Export" }).click();
  await page.getByRole("heading", { name: "Download reconciled data." }).waitFor();

  async function downloadFile(label, endpoint) {
    const requested = page.waitForResponse((response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname.endsWith(`/api/runs/${runId}/${endpoint}`));
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: label, exact: true }).click();
    const [response, download] = await Promise.all([requested, downloaded]);
    assert.equal(response.status(), 200, `${label} must return HTTP 200`);
    const filePath = await download.path();
    assert(filePath, `${label} must produce a browser download`);
    const bytes = await readFile(filePath);
    return {
      filename: download.suggestedFilename(),
      bytes,
      pin: response.headers()["x-samewise-export-snapshot"],
      url: response.url(),
    };
  }

  const trustedFile = await downloadFile("Download reconciled data", "trusted-export");
  await page.locator(".audit-files summary").click();
  const reportFile = await downloadFile("Download reconciliation report", "export");
  const manifestFile = await downloadFile("Download provenance manifest", "manifest");
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  const snapshotPin = trustedFile.pin;
  check("all three browser downloads share one authoritative snapshot",
    /^[a-f0-9]{64}$/.test(snapshotPin ?? "") &&
    reportFile.pin === snapshotPin && manifestFile.pin === snapshotPin &&
    manifest.run.snapshot.authoritativeStateSha256 === snapshotPin);
  check("later downloads actually send the expected snapshot pin",
    [reportFile.url, manifestFile.url].every((url) => new URL(url).searchParams.get("expectedSnapshot") === snapshotPin));
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const artifact = (kind) => manifest.export.artifacts.find((entry) => entry.kind === kind);
  const reportArtifact = artifact("reconciliation_report");
  const trustedArtifact = artifact("trusted_merged_output");
  check("both downloaded CSVs match their manifest filenames, byte lengths and SHA-256 hashes",
    manifest.run.status === "trusted_ready" && manifest.run.runId === runId &&
    Boolean(reportArtifact && trustedArtifact) &&
    reportFile.filename === reportArtifact.filename && trustedFile.filename === trustedArtifact.filename &&
    reportFile.bytes.byteLength === reportArtifact.byteLength &&
    trustedFile.bytes.byteLength === trustedArtifact.byteLength &&
    digest(reportFile.bytes) === reportArtifact.sha256 &&
    digest(trustedFile.bytes) === trustedArtifact.sha256);
  check("source upload fingerprints stay unchanged after merge and export",
    manifest.sourceDatasets.A.sha256 === run.datasets.A.sha256 &&
    manifest.sourceDatasets.B.sha256 === run.datasets.B.sha256);

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
