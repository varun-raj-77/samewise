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

// CI's pinned Ubuntu runner already provides Chrome; local runs keep using
// Playwright's bundled Chromium unless this explicit CI opt-in is enabled.
const browser = await chromium.launch({
  headless: true,
  ...(process.env.SAMEWISE_CI_USE_SYSTEM_CHROME === "1" ? { channel: "chrome" } : {}),
});
const context = await browser.newContext({ viewport: { width: 1500, height: 1050 }, acceptDownloads: true });
const page = await context.newPage();
const checks = [];
const check = (name, condition = true) => { assert(condition, name); checks.push(name); };

try {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
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

  await page.getByRole("button", { name: "Open audit files" }).click();
  const auditTitle = page.getByRole("heading", { name: "Download audit files." });
  await auditTitle.waitFor();
  check("unfinished runs expose audit files, not trusted output",
    await auditTitle.evaluate((heading) => document.activeElement === heading) &&
    await page.getByText(/may include unfinished decisions/).isVisible() &&
    await page.getByRole("button", { name: "Download reconciled data", exact: true }).isDisabled());
  const earlyReport = await downloadFile("Download reconciliation report", "export");
  const earlyManifestFile = await downloadFile("Download provenance manifest", "manifest");
  const earlyManifest = JSON.parse(earlyManifestFile.bytes.toString("utf8"));
  const earlyReportArtifact = earlyManifest.export.artifacts[0];
  check("unfinished audit files share a pinned snapshot and declare no trusted artifact",
    earlyManifest.run.runId === runId && earlyManifest.run.status === "identity_unresolved" &&
    earlyManifest.export.artifacts.length === 1 && earlyReportArtifact?.kind === "reconciliation_report" &&
    earlyReport.pin === earlyManifestFile.pin &&
    earlyManifest.run.snapshot.authoritativeStateSha256 === earlyReport.pin &&
    new URL(earlyManifestFile.url).searchParams.get("expectedSnapshot") === earlyReport.pin &&
    createHash("sha256").update(earlyReport.bytes).digest("hex") === earlyReportArtifact.sha256);
  await page.getByRole("button", { name: "Back to results" }).click();
  await page.getByRole("heading", { name: "Matching complete." }).waitFor();

  await page.getByRole("button", { name: "Review 1 uncertain match" }).click();
  await page.getByRole("heading", { name: "Could these be the same entity?" }).waitFor();
  await page.getByRole("heading", { name: "Could A-1024 and B-2024 be the same entity?" }).waitFor();
  check("the intuitive Orchard Signal case reached the normal review UI", await page.getByText("Orchard Signal Creative", { exact: true }).first().isVisible());

  // A global review shortcut must never submit an identity decision behind
  // the real native New reconciliation dialog. Verify the API request itself,
  // then focus review content and confirm that the normal shortcut still works.
  const decisionRequests = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/candidates\/[^/]+\/decisions$/.test(request.url())) decisionRequests.push(request);
  });
  await page.getByRole("button", { name: "New reconciliation" }).click();
  await page.getByRole("dialog", { name: "Start a new reconciliation?" }).waitFor();
  await page.keyboard.press("s");
  await page.keyboard.press("d");
  check("review shortcuts cannot post identity decisions while the new-run dialog is open", decisionRequests.length === 0);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("heading", { name: "Could A-1024 and B-2024 be the same entity?" }).focus();
  const reviewed = page.waitForResponse((response) => response.request().method() === "POST" && /\/decisions$/.test(response.url()));
  await page.keyboard.press("s");
  check("normal review shortcut still records the intended identity decision", (await reviewed).status() === 200 && decisionRequests.length === 1);
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

  const rejectedPin = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith(`/api/runs/${runId}/trusted-export`) &&
      url.searchParams.get("expectedSnapshot") === earlyReport.pin;
  });
  await page.getByRole("button", { name: "Download reconciled data", exact: true }).click();
  check("a completed run does not mix new trusted data with an earlier audit snapshot",
    (await rejectedPin).status() === 409 &&
    await page.getByText(/Download all report files again/).isVisible());
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

  // Forward the real B upload to the API but drop its response before the
  // page can receive it. The UI must confirm the immutable pair by readback.
  let committedB = null;
  const lostAckRequests = [];
  const captureRecovery = (request) => {
    const url = new URL(request.url());
    const match = /^\/api\/runs\/([^/]+)(?:\/datasets\/(A|B))?$/.exec(url.pathname);
    if (match) lostAckRequests.push({ id: match[1], side: match[2], method: request.method() });
  };
  await page.waitForFunction((oldId) => {
    const currentId = new URL(location.href).searchParams.get("run");
    return currentId && currentId !== oldId;
  }, runId);
  const lostUploadRunId = new URL(page.url()).searchParams.get("run");
  const dropUploadAckRoute = `**/api/runs/${lostUploadRunId}/datasets/B`;
  const dropUploadAck = async (route) => {
    const response = await route.fetch();
    committedB = { status: response.status(), id: lostUploadRunId };
    await route.abort("failed");
  };
  // Keep interception installed until the route has finished. Disabling the
  // last one-shot handler while its request is pending can release it early.
  await page.route(dropUploadAckRoute, dropUploadAck);
  page.on("request", captureRecovery);
  await page.getByRole("button", { name: "Try sample data" }).click();
  await page.getByRole("button", { name: "Use sample data", exact: true }).click();
  await page.getByRole("heading", { name: "Your files are ready." }).waitFor();
  await page.unroute(dropUploadAckRoute, dropUploadAck);
  page.off("request", captureRecovery);
  check("lost upload acknowledgement recovered the actual saved sample without reporting a partial pair",
    committedB?.status === 201 && await page.getByText("Using synthetic sample data.").isVisible() &&
    await page.getByRole("alert").count() === 0);
  const recovery = lostAckRequests.filter((request) => request.id === committedB?.id);
  check("lost upload acknowledgement checked the original run without retrying either immutable upload",
    JSON.stringify(recovery.map(({ method, side }) => [method, side])) ===
      JSON.stringify([["POST", "A"], ["POST", "B"], ["GET", null]]));
  await page.getByRole("button", { name: "Set up matching" }).click();
  await page.getByRole("heading", { name: "Set up matching." }).waitFor();
  check("matching setup can continue on the recovered source pair", true);

  // Use controlled synthetic proposal responses to exercise the navigation
  // race without sending sample records or configuration to an AI service.
  function syntheticProposal(id, reason) {
    return {
      contractVersion: "3.0.0", confirmedMappings: [],
      proposal: {
        contractVersion: "3.0.0", proposalId: "browser-scope-proposal", runId: id,
        provenance: {
          provider: "openai", model: "synthetic-browser-fixture", promptVersion: "semantic-mapping-prompt-v3",
          schemaVersion: "3.0.0", requestVersion: "metadata-first-v3", responseId: "browser-scope-response",
        },
        suggestions: [{
          suggestionId: "sample-name", leftColumn: "company_name", rightColumn: "supplier_name",
          relation: "equivalent", useForMatching: true, includeInMerge: true, sourceSpecific: false,
          semanticFamily: "name_or_title", confidence: 0.9, reason, normalizationHints: ["casefold"],
          status: "pending", finalMapping: null,
        }],
        unmappedLeft: [], unmappedRight: [], createdAt: "2026-08-31T12:00:00.000Z",
      },
    };
  }
  async function holdRecommendation(id, reason) {
    const endpoint = `**/api/runs/${id}/mapping-suggestions`;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let intercepted;
    const received = new Promise((resolve) => { intercepted = resolve; });
    await page.route(endpoint, async (route) => {
      intercepted();
      await gate;
      await route.fulfill({ status: 201, json: syntheticProposal(id, reason) });
    });
    return { release, received };
  }
  const oldRecommendation = await holdRecommendation(committedB.id, "Old synthetic recommendation.");
  await page.getByRole("button", { name: "Get recommended setup" }).click();
  await oldRecommendation.received;
  await page.getByRole("button", { name: "New reconciliation" }).click();
  await page.getByRole("button", { name: "Start new reconciliation" }).click();
  await page.getByRole("heading", { name: "Upload datasets" }).waitFor();
  const newUpload = page.waitForResponse((response) => response.request().method() === "POST" && /\/datasets\/B$/.test(response.url()));
  await page.getByRole("button", { name: "Try sample data" }).click();
  const nextId = new URL((await newUpload).url()).pathname.split("/")[3];
  await page.getByRole("button", { name: "Set up matching" }).click();
  const newRecommendation = await holdRecommendation(nextId, "New synthetic recommendation.");
  await page.getByRole("button", { name: "Get recommended setup" }).click();
  await newRecommendation.received;
  const oldFinished = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/runs/${committedB.id}/mapping-suggestions`);
  oldRecommendation.release();
  await (await oldFinished).finished();
  // Let the browser consume the obsolete response and render any ensuing state.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check("obsolete recommendation cannot replace or stop the next reconciliation's request",
    await page.getByText("Old synthetic recommendation.").count() === 0 &&
    await page.getByText("Reviewing schema metadata…").isVisible());
  newRecommendation.release();
  await page.getByText("New synthetic recommendation.").waitFor();
  check("only the new reconciliation's recommendation is offered",
    await page.getByRole("button", { name: "Use recommended setup" }).isEnabled() &&
    await page.getByText("Reviewing schema metadata…").count() === 0);

  // Revisit the first synthetic run after it accumulated human decisions
  // and merge rules. Do not replace that work without explicit confirmation.
  const priorUrl = `http://127.0.0.1:3000/api/runs/${runId}`;
  const prior = await (await fetch(priorUrl)).json();
  check("the revisited run contains prior review and merge work",
    prior.reviewProgress.reviewed === 1 && prior.trustedExportReadiness.ready && prior.survivorshipPolicy !== null);
  await page.goto(`http://127.0.0.1:5173/?run=${runId}&screen=mapping`);
  const runMatchButton = page.getByRole("button", { name: "Confirm setup & run matching" });
  const rematchDialog = page.getByRole("dialog", { name: "Replace existing match results?" });
  const rematchRequests = [];
  const captureRematch = (request) => {
    const path = new URL(request.url()).pathname;
    if (path === `/api/runs/${runId}/mappings` || path === `/api/runs/${runId}/match`) {
      rematchRequests.push(`${request.method()} ${path.split("/").at(-1)}`);
    }
  };
  page.on("request", captureRematch);
  await runMatchButton.click();
  const cancelRematch = rematchDialog.getByRole("button", { name: "Cancel" });
  check("replacement confirmation warns what will be cleared and defaults focus to Cancel",
    (await rematchDialog.innerText()).includes("recorded review decisions, field resolutions, and merge rules") &&
    await cancelRematch.evaluate((button) => document.activeElement === button));
  await cancelRematch.click();
  await rematchDialog.waitFor({ state: "hidden" });
  await runMatchButton.click();
  await page.keyboard.press("Escape");
  await rematchDialog.waitFor({ state: "hidden" });
  const unchanged = await (await fetch(priorUrl)).json();
  check("Cancel and Escape make no writes and preserve review and merge state",
    rematchRequests.length === 0 && JSON.stringify(prior) === JSON.stringify(unchanged) &&
    await runMatchButton.evaluate((button) => document.activeElement === button));
  await runMatchButton.click();
  const rematched = page.waitForResponse((response) => response.request().method() === "POST" &&
    new URL(response.url()).pathname === `/api/runs/${runId}/match`);
  await rematchDialog.getByRole("button", { name: "Replace results and run matching" }).click();
  const rematchResponse = await rematched;
  const updated = await rematchResponse.json();
  await page.getByRole("heading", { name: "Matching complete." }).waitFor();
  page.off("request", captureRematch);
  check("confirmed replacement reruns the matcher once and retains immutable source fingerprints",
    rematchResponse.status() === 200 && JSON.stringify(rematchRequests) === JSON.stringify(["PUT mappings", "POST match"]) &&
    updated.reviewProgress.reviewed === 0 && updated.survivorshipPolicy === null &&
    updated.datasets.A.sha256 === prior.datasets.A.sha256 && updated.datasets.B.sha256 === prior.datasets.B.sha256);

  // Simulate a dropped acknowledgement after the real matcher finishes.
  // The browser must read the saved run without repeating the mutation.
  await page.goto(`http://127.0.0.1:5173/?run=${runId}&screen=mapping`, { waitUntil: "networkidle" });
  let committedMatch = null;
  const matchRecoveryRequests = [];
  const captureMatchRecovery = (request) => {
    const path = new URL(request.url()).pathname;
    if ([`/api/runs/${runId}`, `/api/runs/${runId}/mappings`, `/api/runs/${runId}/match`].includes(path)) {
      matchRecoveryRequests.push(`${request.method()} ${path}`);
    }
  };
  const dropMatchAckRoute = `**/api/runs/${runId}/match`;
  const dropMatchAck = async (route) => {
    const response = await route.fetch();
    committedMatch = { status: response.status(), run: await response.json() };
    await route.abort("failed");
  };
  await page.route(dropMatchAckRoute, dropMatchAck);
  page.on("request", captureMatchRecovery);
  await runMatchButton.click();
  await rematchDialog.getByRole("button", { name: "Replace results and run matching" }).click();
  await page.getByRole("heading", { name: "Matching complete." }).waitFor();
  await page.unroute(dropMatchAckRoute, dropMatchAck);
  page.off("request", captureMatchRecovery);
  check("an interrupted match acknowledgement recovered real, same-plan results",
    committedMatch?.status === 200 && committedMatch.run.runId === runId &&
    JSON.stringify(committedMatch.run.mappings) === JSON.stringify(prior.mappings) &&
    committedMatch.run.matcherProvenance !== null && await page.getByRole("alert").count() === 0);
  check("recovery does not treat uncertain matches as reviewed or trusted",
    committedMatch.run.reviewProgress.remaining === 1 && !committedMatch.run.trustedExportReadiness.ready &&
    await page.getByRole("button", { name: "Review 1 uncertain match" }).isVisible());
  check("matching recovery performs one authoritative GET and no repeated mutation",
    JSON.stringify(matchRecoveryRequests) === JSON.stringify([
      `PUT /api/runs/${runId}/mappings`, `POST /api/runs/${runId}/match`, `GET /api/runs/${runId}`,
    ]));

  console.log(JSON.stringify({ status: "PASS", runId, checks }, null, 2));
} finally {
  await browser.close();
}
