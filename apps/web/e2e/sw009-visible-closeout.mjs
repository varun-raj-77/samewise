import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
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
const artifactRoot = resolve(root, "evaluation/reports/sw-009/walkthrough");
await mkdir(artifactRoot, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const report = {
  status: "RUNNING",
  checks: [],
  browserConsoleErrors: [],
  browserHttpErrors: [],
  screenshots: [],
};
const check = (name, value = true) => {
  assert(value, name);
  report.checks.push(name);
};
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) report.browserConsoleErrors.push(message.text());
});
page.on("pageerror", (error) => report.browserConsoleErrors.push(error.message));
page.on("response", (response) => {
  if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) report.browserHttpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
});

try {
  await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Start with two messy CSV files." }).waitFor();
  check("Samewise opened at the normal reconciliation product");
  await page.getByRole("button", { name: "Evaluation" }).click();
  await page.getByRole("heading", { name: "What changed between matcher versions?" }).waitFor();
  check("Evaluation navigation opened the dedicated product screen");
  check("frozen holdout fixture identity is visible", await page.getByText("organizations-matcher-holdout-1200-v1").isVisible());
  check("synthetic source type is explicit", await page.getByText("SYNTHETIC GROUND TRUTH").isVisible());
  check("candidate and matcher versions are visible", await page.getByText("candidate-engine-v0.3.0").first().isVisible() && await page.getByText("explainable-matcher-v0.2.0").first().isVisible());
  check("SW-005F weak-identifier evidence is also surfaced", await page.getByRole("heading", { name: "SW-005F weak-identifier falsification" }).isVisible());

  const metricArticle = (name) => page.getByRole("heading", { name }).locator("..");
  check("candidate recall has its exact denominator", (await metricArticle("Candidate recall").innerText()).includes("866 / 879"));
  check("auto-match precision has its exact denominator", (await metricArticle("Auto-match precision").innerText()).includes("253 / 253"));
  check("review rate has its row-level denominator", (await metricArticle("Review rate").innerText()).includes("598 / 858"));
  check("end-to-end recovery has its exact denominator", (await metricArticle("End-to-end true-link recovery").innerText()).includes("864 / 879"));
  check("pipeline decomposition is rendered", await page.getByRole("heading", { name: "Where true links were lost" }).isVisible() && await page.getByText("Reached candidate set").isVisible());
  check("all accepted matcher gates are visible and passed", await page.getByText("All current gates passed").isVisible());

  check("compatible baseline comparison is explicit", await page.getByText("Comparable", { exact: true }).isVisible());
  const comparison = page.getByRole("table", { name: /Baseline matcher compared/ });
  const comparisonText = await comparison.innerText();
  check("baseline and v0.2 review-rate delta is rendered", comparisonText.includes("99.18%") && comparisonText.includes("69.70%") && comparisonText.includes("-29.49 pp"));
  check("top-1 delta is rendered", comparisonText.includes("97.40%") && comparisonText.includes("99.17%") && comparisonText.includes("+1.77 pp"));
  check("undefined baseline precision is not rendered as zero", /Auto-match precision\s+—\s+100\.00%\s+—/.test(comparisonText));

  await page.getByRole("heading", { name: "Empirical score bands" }).scrollIntoViewIfNeeded();
  check("score-band analysis is visible", await page.getByText("0.5-0.6", { exact: true }).isVisible());
  check("the UI makes no probability claim", !(await page.locator("body").innerText()).toLowerCase().includes("probability"));

  await page.getByRole("tab", { name: /Candidate misses/ }).click();
  await page.locator(".evaluation-error-card").first().waitFor();
  check("candidate-stage miss evidence is inspectable", await page.locator(".evaluation-error-card").first().getByText(/candidate generation/i).isVisible());
  check("hidden truth is strongly marked evaluation-only", await page.locator(".evaluation-error-card").first().getByText(/Evaluation-only truth · SAME/).isVisible());
  check("error rendering is bounded by API pagination", await page.locator(".evaluation-error-card").count() <= 20);

  await page.getByRole("tab", { name: /False unmatched/ }).click();
  await page.locator(".evaluation-error-card").first().waitFor();
  check("false-unmatched outcomes are inspectable", await page.locator(".evaluation-error-card").count() === 14);

  await page.getByRole("tab", { name: /Hard negatives/ }).click();
  await page.getByText(/Evaluation-only truth · DIFFERENT/).first().waitFor();
  check("hard-negative cases are inspectable", await page.locator(".evaluation-error-card").count() === 6);
  check("hard-negative example was not auto-matched", await page.getByText(/auto-matched: no/).first().isVisible());

  const mutationRequests = [];
  page.on("request", (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) mutationRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.getByLabel("Auto-match threshold").selectOption("0.55");
  check("threshold what-if updates retrospective counts", await page.getByText("113", { exact: true }).isVisible());
  check("threshold control cannot deploy configuration", await page.getByText(/cannot change production matcher configuration/i).isVisible() && mutationRequests.length === 0);
  check("human-review sampling caveat is visible", await page.getByText("Reviewed subset · not representative").isVisible() && await page.getByText(/may not represent the full dataset distribution/).isVisible());

  const screenshotPath = join(artifactRoot, "sw009-evaluation.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  report.screenshots.push(screenshotPath);
  await page.getByRole("button", { name: "Reconciliation", exact: true }).click();
  await page.getByRole("heading", { name: "Start with two messy CSV files." }).waitFor();
  check("normal reconciliation remains available after evaluation");

  check("no browser console errors", report.browserConsoleErrors.length === 0);
  check("no browser HTTP errors", report.browserHttpErrors.length === 0);
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  throw error;
} finally {
  await writeFile(join(artifactRoot, "sw009-closeout.json"), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}

console.log(JSON.stringify(report, null, 2));
