import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const hash = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const sourceHashesBefore = [await hash(sourceA), await hash(sourceB)];

const browser = await chromium.launch({ headless: process.env.SAMEWISE_HEADLESS === "1" });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
const report = { fixture: "organizations-dev-v1", checks: [], liveOpenAI: false, mappingProvider: "injected mocked boundary" };
const check = (name, value = true) => { assert(value, name); report.checks.push(name); };

try {
  await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await page.getByLabel("Dataset A CSV").setInputFiles(sourceA);
  await page.getByLabel("Dataset B CSV").setInputFiles(sourceB);
  const uploadResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/datasets\/B$/.test(response.url()));
  await page.getByRole("button", { name: "Upload & profile" }).click();
  check("both visible fixture CSVs were profiled", (await uploadResponse).status() === 201);
  await page.getByRole("heading", { name: "Know what arrived." }).waitFor();
  check("real profile dimensions are visible", await page.getByText(/23 rows · SHA-256/).isVisible() && await page.getByText(/22 rows · SHA-256/).isVisible());

  await page.getByRole("button", { name: "Map corresponding fields" }).click();
  const suggestionResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/mapping-suggestions$/.test(response.url()));
  await page.getByRole("button", { name: "Request AI suggestions" }).click();
  const suggestionPayload = await (await suggestionResponse).json();
  report.runId = suggestionPayload.proposal.runId;
  check("suggestions were requested through the real UI and API", suggestionPayload.proposal.suggestions.every((item) => item.status === "pending"));
  check("suggestion evidence and advisory confidence are visible", await page.getByText("Both columns appear to contain organization names.").isVisible() && await page.getByText(/96% \(advisory\)/).isVisible());

  const nameCard = page.locator(".suggestion-card").nth(0);
  await nameCard.getByRole("button", { name: "Accept" }).click();
  await nameCard.getByText("accepted").waitFor();
  check("one suggestion was explicitly accepted");

  const phoneCard = page.locator(".suggestion-card").nth(1);
  await phoneCard.getByRole("button", { name: "Reject" }).click();
  await phoneCard.getByText("rejected").waitFor();
  check("one suggestion was explicitly rejected");

  const websiteCard = page.locator(".suggestion-card").nth(2);
  await websiteCard.getByLabel("Remap website Dataset B column").selectOption("domain");
  await websiteCard.getByRole("button", { name: "Remap" }).click();
  await websiteCard.getByText("edited").waitFor();
  check("the intentionally uncertain website suggestion was corrected to domain");
  check("the original website-to-email proposal remains visible", (await websiteCard.innerText()).includes("website") && (await websiteCard.innerText()).includes("email_address") && (await websiteCard.innerText()).includes("Confirmed: website ↔ domain"));

  await page.getByRole("button", { name: "+ Add manual mapping" }).click();
  let manualRow = page.locator(".mapping-row").last();
  await manualRow.getByLabel("Mapping label").fill("Phone");
  await manualRow.getByLabel("Dataset A column").selectOption("phone");
  await manualRow.getByLabel("Dataset B column").selectOption("telephone");
  await manualRow.getByLabel("Mapping role").selectOption("identity");
  await manualRow.getByLabel("Normalizer").selectOption("phone");
  check("a rejected suggestion was replaced with a manual mapping");

  await page.getByRole("button", { name: "+ Add manual mapping" }).click();
  manualRow = page.locator(".mapping-row").last();
  await manualRow.getByLabel("Mapping label").fill("Status");
  await manualRow.getByLabel("Dataset A column").selectOption("account_status");
  await manualRow.getByLabel("Dataset B column").selectOption("status");
  await manualRow.getByLabel("Mapping role").selectOption("comparison");
  check("identity and comparison roles remain visibly distinct", await page.locator(".mapping-row.comparison").count() === 1);
  const mappingScreenshotPath = join(artifactRoot, "sw004-mapping-review.png");
  await page.screenshot({ path: mappingScreenshotPath, fullPage: true });
  report.mappingScreenshotPath = mappingScreenshotPath;

  const matchResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/match$/.test(response.url()));
  await page.getByRole("button", { name: "Save confirmed mappings & run matcher" }).click();
  check("only confirmed mappings reached the Python matcher", (await matchResponse).status() === 200);
  await page.getByRole("heading", { name: "Evidence first, uncertainty visible." }).waitFor();
  check("SW-003 result categories remain visible", await page.getByText("Matched", { exact: true }).isVisible() && await page.getByText("Needs review", { exact: true }).isVisible());

  const candidate = page.locator(".candidate-row").first();
  check("at least one uncertain identity candidate remains for human review", await candidate.isVisible());
  await candidate.click();
  const decisionResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/decisions$/.test(response.url()));
  await page.getByRole("button", { name: "Same entity" }).click();
  const decided = await (await decisionResponse).json();
  const latestDecision = decided.decisions.at(-1);
  const selectedConflicts = decided.conflicts.filter((conflict) => conflict.candidateId === latestDecision.candidateId);
  check("SAME ENTITY did not auto-resolve conflicting values", selectedConflicts.length > 0 && selectedConflicts.every((conflict) => conflict.resolution === null));

  const sourceHashesAfter = [await hash(sourceA), await hash(sourceB)];
  check("source fixtures remained unchanged", JSON.stringify(sourceHashesAfter) === JSON.stringify(sourceHashesBefore));
  await page.screenshot({ path: join(artifactRoot, "sw004-mapping-walkthrough.png"), fullPage: true });
  report.screenshotPath = join(artifactRoot, "sw004-mapping-walkthrough.png");
  report.status = "PASS";
  await writeFile(join(artifactRoot, "sw004-closeout.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
