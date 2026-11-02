import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const runtimeModules = process.env.SAMEWISE_RUNTIME_NODE_MODULES;
assert(runtimeModules, "SAMEWISE_RUNTIME_NODE_MODULES is required.");
const require = createRequire(import.meta.url);
const entry = require.resolve("playwright", { paths: [runtimeModules] });
const imported = await import(pathToFileURL(entry).href);
const { chromium } = imported.default ?? imported;

const runId = "run-sw034-browser";
const reportName = "samewise-" + runId + "-reconciliation.csv";
const trustedName = "samewise-" + runId + "-trusted-merged.csv";
const reportBytes = Buffer.from("id,name\r\n1,Café ☕\r\n", "utf8");
const trustedBytes = Buffer.from("id,name\r\n1,Café ☕\r\n", "utf8");
const hex = (value) => createHash("sha256").update(value).digest("hex");
const checks = [];
function check(label, condition) {
  assert(condition, label);
  checks.push(label);
}
function artifact(kind, filename, bytes) {
  return {
    kind,
    version: kind === "reconciliation_report"
      ? "reconciliation-export-v3.0.0" : "trusted-merged-export-v2.0.0",
    filename,
    mediaType: "text/csv; charset=utf-8",
    sha256: hex(bytes),
    byteLength: bytes.length,
  };
}
function manifest(ready = true) {
  const source = (side) => ({
    side, datasetId: "dataset-" + side, originalFilename: side + ".csv",
    sha256: "a".repeat(64), rowCount: 1, profileSchemaVersion: "1.0.0",
  });
  return {
    manifestVersion: "run-manifest-v1.0.0",
    run: {
      runId, status: ready ? "trusted_ready" : "identity_unresolved", stage: "export",
      snapshot: {
        descriptorVersion: "export-snapshot-v1.0.0",
        authoritativeStateSha256: "b".repeat(64),
      },
      relevantTimestamps: {
        mappingProposalCreatedAt: null, firstIdentityDecisionAt: null,
        lastIdentityDecisionAt: null, policyConfiguredAt: null, lastResolutionAt: null,
      },
    },
    sourceDatasets: { A: source("A"), B: source("B") },
    semanticMapping: { mappingVersion: "confirmed-mappings-v3", confirmedMappings: [], ai: null },
    candidateGeneration: {
      candidateEngineVersion: "candidate-engine-v0.4.0",
      blockingNormalizationVersion: "blocking-normalization-v0.1.0",
      candidateConfigVersion: null, candidateConfigAvailability: "not_retained",
      evidencePlanVersion: "1.0.0", evidencePlanSha256: hex("{}"), evidencePlan: {},
    },
    matcher: {
      featurePipelineVersion: "feature-pipeline-v0.2.0",
      matcherVersion: "explainable-matcher-v0.3.0",
      matcherConfigVersion: "matcher-config-v0.3.0",
      matcherConfig: {}, scoreSemanticsVersion: "1.0.0",
    },
    identity: {
      systemEstablishedLinkCount: 0, humanSameCount: 0, humanDifferentCount: 0,
      pendingCount: ready ? 0 : 1, deferredCount: 0, collisionRelatedCount: 0,
      humanBatchPairCount: 0, reviewSignatureVersion: "1.0.0",
    },
    survivorship: {
      policySchemaVersion: "1.0.0", policyVersion: null,
      configuredFieldPolicies: [], manualResolutionCount: 0,
      ruleGeneratedResolutionCount: 0, keepBothCount: 0,
      unresolvedConflictCount: 0,
    },
    evaluation: {
      applicable: false, snapshotId: null, snapshotVersion: null,
      reason: "No versioned evaluation snapshot is attached to this ordinary product run.",
    },
    export: {
      artifacts: [
        artifact("reconciliation_report", reportName, reportBytes),
        ...(ready ? [artifact("trusted_merged_output", trustedName, trustedBytes)] : []),
      ],
    },
  };
}
function payload(name, bytes, mimeType = "text/csv") {
  return { name, mimeType, buffer: Buffer.from(bytes) };
}
function summaryRun() {
  const profile = (side) => ({
    contractVersion: "1.0.0", datasetId: "dataset-" + side, side,
    originalFilename: side + ".csv", sha256: "a".repeat(64),
    rowCount: 1, columns: [{
      name: "name", inferredType: "string", nullCount: 0, nullRate: 0,
      distinctCount: 1, distinctRate: 1, samples: ["Example"],
    }],
  });
  return {
    contractVersion: "1.0.0", projectionVersion: "1.0.0", runId,
    stage: "export", datasets: { A: profile("A"), B: profile("B") },
    mappings: [], mappingVersion: "confirmed-mappings-v3",
    semanticMappingProvenance: null, matcherVersion: "explainable-matcher-v0.3.0",
    summary: { matched: 0, needsReview: 0, onlyA: 1, onlyB: 1 },
    matcherProvenance: {
      matcherVersion: "explainable-matcher-v0.3.0",
      candidateEngineVersion: "candidate-engine-v0.4.0",
      blockingNormalizationVersion: "blocking-normalization-v0.1.0",
      featurePipelineVersion: "feature-pipeline-v0.2.0",
      matcherConfigVersion: "matcher-config-v0.3.0",
      matcherConfig: { frozen: true },
    },
    survivorshipPolicy: null,
    trustedExportReadiness: {
      ready: true, unresolvedIdentityCount: 0, unresolvedConflictCount: 0,
      eligibleConfirmedCount: 0, onlyACount: 1, onlyBCount: 1, blockers: [],
    },
    reviewProgress: { total: 0, reviewed: 0, remaining: 0, deferred: 0 },
    reviewUndo: null, conflictSummary: { total: 0, resolved: 0, unresolved: 0 },
  };
}
async function select(page, ready = true) {
  await page.getByLabel("Provenance manifest for verification").setInputFiles(
    payload("samewise-" + runId + "-manifest.json", Buffer.from(JSON.stringify(manifest(ready)), "utf8"), "application/json"),
  );
  await page.getByLabel("Reconciliation report for verification").setInputFiles(payload(reportName, reportBytes));
  await page.getByLabel("Trusted merged output for verification").setInputFiles(
    ready ? payload(trustedName, trustedBytes) : [],
  );
}
async function verifySuccess(page, count) {
  await page.getByRole("button", { name: "Check file integrity" }).click();
  await page.locator(".export-verifier-success").waitFor({ state: "visible" });
  check("browser verified " + count + " CSV artifact(s)", 
    (await page.locator(".export-verifier-success").innerText()).includes(count + " CSV file"));
}
async function verifyFailure(page, phrase) {
  await page.getByRole("button", { name: "Check file integrity" }).click();
  await page.locator(".export-verifier-error").waitFor({ state: "visible" });
  check("browser rejected " + phrase,
    (await page.locator(".export-verifier-error").innerText()).includes(phrase));
}
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
const apiMutations = [];
let capture = false;
page.on("request", (request) => {
  if (capture && /\/api\//.test(request.url()) && request.method() !== "GET") {
    apiMutations.push(request.method() + " " + request.url());
  }
});
try {
  await page.goto("http://127.0.0.1:5173/", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Upload datasets" }).waitFor();
  const uploadPanel = page.locator("details.export-verifier");
  check("local checker appears on upload screen", await uploadPanel.count() === 1);
  await uploadPanel.locator("summary").click();
  capture = true;
  await select(page);
  await verifySuccess(page, 2);
  check("browser did not send verifier files to API", apiMutations.length === 0);
  check("CSV rows never appeared in the interface",
    await page.getByText("Café ☕", { exact: true }).count() === 0);

  const tampered = Buffer.from(reportBytes);
  tampered[0] ^= 1;
  await page.getByLabel("Reconciliation report for verification").setInputFiles(payload(reportName, tampered));
  check("file change clears stale success", await page.locator(".export-verifier-success").count() === 0);
  await verifyFailure(page, "SHA-256 hash differs");
  await page.getByLabel("Reconciliation report for verification").setInputFiles(payload("renamed.csv", reportBytes));
  await verifyFailure(page, "filenames do not match");
  await page.getByLabel("Reconciliation report for verification").setInputFiles(payload(reportName, reportBytes));
  await page.getByLabel("Trusted merged output for verification").setInputFiles([]);
  await verifyFailure(page, "exactly the CSV files");
  await select(page, false);
  await verifySuccess(page, 1);

  await select(page, true);
  await page.evaluate(() => {
    const nativeText = File.prototype.text;
    File.prototype.text = function () {
      return new Promise((resolve, reject) => {
        window.__samewiseReleaseFile = () => {
          nativeText.call(this).then(resolve, reject);
        };
      });
    };
  });
  await page.getByRole("button", { name: "Check file integrity" }).click();
  await page.waitForFunction(() => typeof window.__samewiseReleaseFile === "function");
  await page.getByLabel("Reconciliation report for verification").setInputFiles(payload(reportName, tampered));
  await page.evaluate(() => window.__samewiseReleaseFile());
  await page.waitForTimeout(100);
  check("in-flight obsolete verification produced no success", await page.locator(".export-verifier-success").count() === 0);
  check("in-flight obsolete verification produced no error", await page.locator(".export-verifier-error").count() === 0);

  capture = false;
  await page.route("**/api/runs/" + runId, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summaryRun()) }),
  );
  await page.goto("http://127.0.0.1:5173/?run=" + runId + "&screen=export", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Download reconciled data." }).waitFor();
  check("local checker appears on export screen", await page.locator("details.export-verifier").count() === 1);
  await page.locator("details.export-verifier summary").click();
  capture = true;
  await select(page);
  await verifySuccess(page, 2);
  check("export-screen check triggered no API mutation", apiMutations.length === 0);

  console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
} finally {
  await browser.close();
}
