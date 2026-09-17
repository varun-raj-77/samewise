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
const artifactRoot = resolve(root, ".samewise-data/acceptance/sw-008");
await mkdir(artifactRoot, { recursive: true });
const deterministicA = join(artifactRoot, "newest-formula-a.csv");
const deterministicB = join(artifactRoot, "newest-formula-b.csv");
await writeFile(deterministicA, "vendor_name,contact_email,account_status,updated_at\r\nFormula Co,formula@example.com,=ACTIVE,2026-03-01T12:00:00Z\r\nAlpha Singular,alpha@alpha-only.invalid,active,2026-01-01T00:00:00Z\r\n");
await writeFile(deterministicB, "organization,email_address,status,last_updated\r\nFormula Co,formula@example.com,inactive,2026-02-01T12:00:00Z\r\nZulu Orphan,zulu@zulu-only.invalid,inactive,2026-01-01T00:00:00Z\r\n");

const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const sourceHashesBefore = [await digest(sourceA), await digest(sourceB)];
const mappings = [
  ["Organization", "vendor_name", "organization", "identity", "text"],
  ["Email", "contact_email", "email_address", "identity", "email"],
  ["Street", "street", "address_line_1", "identity", "text"],
  ["City", "city", "locality", "identity", "text"],
  ["State", "state", "region", "identity", "text"],
  ["Postal code", "zip", "postal_code", "identity", "text"],
  ["Website", "website", "domain", "identity", "text"],
  ["Phone", "phone", "telephone", "comparison", "phone"],
  ["Status", "account_status", "status", "comparison", "text"],
  ["Balance", "balance", "outstanding_balance", "comparison", "number"],
  ["Updated at", "updated_at", "last_updated", "comparison", "date"],
];

const browser = await chromium.launch({
  headless: process.env.SAMEWISE_HEADLESS === "1",
  slowMo: process.env.SAMEWISE_HEADLESS === "1" ? 0 : 25,
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const report = {
  status: "RUNNING",
  fixture: "organizations-dev-v1",
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

let runId;
const fetchRun = async () => {
  const response = await fetch(`http://127.0.0.1:3000/api/runs/${runId}`);
  assert(response.ok, `GET run failed with ${response.status}`);
  return response.json();
};
const screenshot = async (name) => {
  const path = join(artifactRoot, name);
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push(path);
};
const selectReviewItem = async (aRowId) => {
  await page.getByLabel("Filter review queue").selectOption("unresolved");
  const search = page.getByRole("searchbox", { name: "Search review queue" });
  await search.fill(aRowId);
  await page.getByTestId("review-queue-row").filter({ hasText: aRowId }).click();
  await search.fill("");
};
const decideCurrent = async (decision) => {
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && /\/decisions$/.test(response.url()));
  await page.getByRole("button", { name: decision === "same_entity" ? "Same entity" : "Different entity", exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  return response.json();
};
const conflictCard = (conflict) => page.locator(".conflict-card")
  .filter({ hasText: `${conflict.aRowId ?? ""}` })
  .filter({ hasText: conflict.label })
  .filter({ hasText: conflict.aValue || "Empty" })
  .first();
const clickResolution = async (conflict, buttonName, method = "POST") => {
  const responsePromise = page.waitForResponse((response) => response.request().method() === method && response.url().includes(`/conflicts/${conflict.conflictId}/`));
  await conflictCard(conflict).getByRole("button", { name: buttonName, exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  return response.json();
};
const policySelect = (label) => page.locator(".policy-controls label").filter({ hasText: new RegExp(`^${label}`) }).locator("select");
const configureRule = async ({ field, strategy, trustedSource, timestampField }) => {
  await policySelect("Comparison field").selectOption({ label: field });
  await policySelect("Rule").selectOption(strategy);
  if (trustedSource) await policySelect("Trusted source").selectOption(trustedSource);
  if (timestampField) await policySelect("Timestamp mapping").selectOption({ label: timestampField });
  const responsePromise = page.waitForResponse((response) => response.request().method() === "PUT" && /\/survivorship-policy$/.test(response.url()));
  await page.getByRole("button", { name: "Save policy" }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  return response.json();
};
const previewRule = async () => {
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && /\/survivorship-preview$/.test(response.url()));
  await page.getByRole("button", { name: "Preview rule" }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  return response.json();
};
const applyRule = async (expectedStatus = 200) => {
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && /\/survivorship-apply$/.test(response.url()));
  await page.getByRole("button", { name: "Apply previewed rule" }).click();
  const response = await responsePromise;
  assert.equal(response.status(), expectedStatus);
  return response.json();
};

try {
  await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Upload datasets" }).waitFor();
  check("Samewise opened in a rendered Chromium browser");

  await page.getByLabel("Dataset A CSV").setInputFiles(sourceA);
  await page.getByLabel("Dataset B CSV").setInputFiles(sourceB);
  const uploaded = page.waitForResponse((response) => response.request().method() === "POST" && /\/datasets\/B$/.test(response.url()));
  await page.getByRole("button", { name: "Upload & profile" }).click();
  const uploadResponse = await uploaded;
  runId = new URL(uploadResponse.url()).pathname.split("/")[3];
  report.runId = runId;
  await page.getByRole("heading", { name: "Know what arrived." }).waitFor();
  check("normal development Dataset A and B were uploaded through the UI", uploadResponse.status() === 201);

  await page.getByRole("button", { name: "Map corresponding fields" }).click();
  for (let index = 0; index < mappings.length; index += 1) await page.getByRole("button", { name: "+ Add manual mapping" }).click();
  const mappingRows = page.locator(".mapping-row");
  for (let index = 0; index < mappings.length; index += 1) {
    const [label, aColumn, bColumn, role, normalizer] = mappings[index];
    const row = mappingRows.nth(index);
    await row.getByLabel("Mapping label").fill(label);
    await row.getByLabel("Dataset A column").selectOption(aColumn);
    await row.getByLabel("Dataset B column").selectOption(bColumn);
    await row.getByLabel("Mapping role").selectOption(role);
    await row.getByLabel("Normalizer").selectOption(normalizer);
  }
  check("identity and four comparison mappings were explicitly confirmed", await page.locator(".mapping-row.identity").count() === 7 && await page.locator(".mapping-row.comparison").count() === 4);

  const matchedResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/match$/.test(response.url()));
  await page.getByRole("button", { name: "Save confirmed mappings & run matcher" }).click();
  check("React reached Fastify and the real Python matcher", (await matchedResponse).status() === 200);
  await page.getByRole("heading", { name: "Evidence first, uncertainty visible." }).waitFor();
  const matched = await fetchRun();
  report.initialSummary = matched.summary;

  await page.getByRole("button", { name: "Prepare export" }).click();
  await page.getByRole("heading", { name: "Report everything. Trust only what is ready." }).waitFor();
  check("reconciliation and manifest remain available while identity is unresolved",
    await page.getByRole("button", { name: "Download reconciliation report" }).isEnabled()
    && await page.getByRole("button", { name: "Download provenance manifest" }).isEnabled());
  check("trusted output shows the exact unresolved-identity blocker",
    await page.getByRole("button", { name: "Download trusted merged output" }).isDisabled()
    && await page.getByRole("status").getByText(/identity review item\(s\) remain unresolved/).isVisible());
  await page.getByRole("button", { name: "Reconciliation", exact: true }).click();
  await page.getByRole("heading", { name: "Evidence first, uncertainty visible." }).waitFor();

  const autoContext = matched.candidates.find((candidate) => candidate.aRowId === "A000007" && candidate.bRowId === "B000012");
  const humanSame = matched.candidates.find((candidate) => candidate.aRowId === "A000009" && candidate.bRowId === "B000015");
  assert(autoContext?.band === "auto_match" && humanSame?.band === "needs_review", "Expected the versioned fixture auto-match and review candidate.");
  await page.getByRole("button", { name: "Open review workspace" }).click();
  await page.getByRole("heading", { name: "Resolve identity uncertainty." }).waitFor();

  for (;;) {
    const current = await fetchRun();
    const item = current.reviewQueue.find((entry) => entry.state === "needs_review" && entry.aRowId !== humanSame.aRowId);
    if (!item) break;
    await selectReviewItem(item.aRowId);
    while ((await fetchRun()).reviewQueue.find((entry) => entry.aRowId === item.aRowId)?.state === "needs_review") await decideCurrent("different_entity");
  }
  const beforeSame = await fetchRun();
  const sameItem = beforeSame.reviewQueue.find((entry) => entry.aRowId === humanSame.aRowId);
  assert(sameItem?.state === "needs_review", `Expected ${humanSame.aRowId} to remain available for SAME.`);
  await selectReviewItem(humanSame.aRowId);
  const targetButton = page.getByRole("button", { name: new RegExp(`Select candidate rank ${humanSame.rank}, ${humanSame.bRowId}`) });
  if ((await targetButton.getAttribute("aria-pressed")) !== "true") await targetButton.click();
  await decideCurrent("same_entity");
  const identitiesClosed = await fetchRun();
  check("a SAME identity was deliberately confirmed last and all other review identities were closed", identitiesClosed.reviewProgress.remaining === 0 && identitiesClosed.decisions.filter((decision) => decision.humanDecision === "same_entity").length === 1);
  check("SAME created conflicts but zero resolutions", identitiesClosed.conflicts.filter((conflict) => conflict.candidateId === humanSame.candidateId).length > 0 && identitiesClosed.conflicts.every((conflict) => conflict.resolution === null));

  await page.getByRole("button", { name: "Resolve values separately" }).click();
  await page.getByRole("heading", { name: "Identity is settled. Values are not." }).waitFor();
  check("survivorship is a dedicated workspace separate from SAME and DIFFERENT", await page.getByRole("heading", { name: "Preview before apply" }).isVisible() && await page.getByRole("button", { name: "Same entity" }).count() === 0);

  const unresolved = await fetchRun();
  const phone = unresolved.conflicts.find((conflict) => conflict.candidateId === humanSame.candidateId && conflict.label === "Phone" && [conflict.aValue, conflict.bValue].filter((value) => value.trim() === "").length === 1);
  const balance = unresolved.conflicts.find((conflict) => conflict.candidateId === autoContext.candidateId && conflict.label === "Balance");
  const updated = unresolved.conflicts.find((conflict) => conflict.candidateId === humanSame.candidateId && conflict.label === "Updated at" && Date.parse(conflict.aValue) !== Date.parse(conflict.bValue));
  const statusEqual = unresolved.conflicts.find((conflict) => {
    if (conflict.label !== "Status") return false;
    const candidate = unresolved.candidates.find((item) => item.candidateId === conflict.candidateId);
    return candidate?.candidateId === autoContext.candidateId && candidate.aRecord.updated_at === candidate.bRecord.last_updated;
  });
  assert(phone && balance && updated && statusEqual, "Expected phone, balance, updated, and equal-timestamp status conflicts.");
  for (const conflict of [phone, balance, updated, statusEqual]) {
    const candidate = unresolved.candidates.find((item) => item.candidateId === conflict.candidateId);
    conflict.aRowId = candidate.aRowId;
    conflict.bRowId = candidate.bRowId;
  }

  await clickResolution(statusEqual, "Use A");
  let state = await fetchRun();
  check("Use A selects Dataset A with manual provenance", state.conflicts.find((item) => item.conflictId === statusEqual.conflictId).resolution?.chosenSource === "A" && state.conflicts.find((item) => item.conflictId === statusEqual.conflictId).resolution?.resolutionSource === "manual");
  await clickResolution(balance, "Use B");
  state = await fetchRun();
  check("Use B selects Dataset B with manual provenance", state.conflicts.find((item) => item.conflictId === balance.conflictId).resolution?.chosenSource === "B" && state.conflicts.find((item) => item.conflictId === balance.conflictId).resolution?.resolutionSource === "manual");
  await clickResolution(updated, "Keep both");
  state = await fetchRun();
  const kept = state.conflicts.find((item) => item.conflictId === updated.conflictId).resolution;
  check("KEEP BOTH retains both source-tagged values and no canonical winner", kept?.strategy === "keep_both" && kept.chosenSource === null && kept.chosenValue === null && kept.keptValues.length === 2);
  await clickResolution(statusEqual, "Use B");
  state = await fetchRun();
  const changed = state.conflicts.find((item) => item.conflictId === statusEqual.conflictId);
  check("changing a resolution updates current truth and preserves history", changed.resolution?.chosenSource === "B" && changed.resolutionHistory.length === 1 && await conflictCard(statusEqual).getByText(/1 prior resolution retained/).isVisible());

  const beforePolicy = state.conflicts.filter((conflict) => conflict.resolution).length;
  await configureRule({ field: "Phone", strategy: "prefer_non_null" });
  state = await fetchRun();
  check("saving a policy creates zero resolutions", state.conflicts.filter((conflict) => conflict.resolution).length === beforePolicy);
  const nonNullPreview = await previewRule();
  check("prefer non-null preview reports affected, resolvable, and unresolved counts", nonNullPreview.affectedCount >= 2 && nonNullPreview.resolvableCount >= 1 && nonNullPreview.unresolvedCount >= 1);
  check("preview itself creates zero resolutions", (await fetchRun()).conflicts.find((item) => item.conflictId === phone.conflictId).resolution === null);

  await clickResolution(statusEqual, "Use A");
  const staleApply = await applyRule(409);
  check("a stale preview cannot be applied after relevant state changes", staleApply.error?.code === "survivorship_preview_required" && (await fetchRun()).conflicts.find((item) => item.conflictId === phone.conflictId).resolution === null);
  const freshNonNull = await previewRule();
  const nonNullApplied = await applyRule();
  state = await fetchRun();
  const phoneNonNull = state.conflicts.find((item) => item.conflictId === phone.conflictId).resolution;
  check("prefer non-null applies only after an explicit fresh preview", freshNonNull.resolvableCount >= 1 && nonNullApplied.appliedCount >= 1 && phoneNonNull?.resolutionSource === "rule");

  await clickResolution(phone, "Clear resolution", "DELETE");
  const missingTrustedSource = phone.aValue.trim() === "" ? "A" : "B";
  const presentTrustedSource = missingTrustedSource === "A" ? "B" : "A";
  await configureRule({ field: "Phone", strategy: "prefer_trusted_source", trustedSource: missingTrustedSource });
  const missingTrustedPreview = await previewRule();
  const missingTrustedApply = await applyRule();
  const missingTrustedItem = missingTrustedPreview.items.find((item) => item.conflictId === phone.conflictId);
  check("trusted-source missing values do not silently fall back", missingTrustedItem?.outcome === "unresolved" && missingTrustedItem.reasonCode === "trusted_source_missing" && missingTrustedApply.unresolvedCount >= 1 && (await fetchRun()).conflicts.find((item) => item.conflictId === phone.conflictId).resolution === null);
  await configureRule({ field: "Phone", strategy: "prefer_trusted_source", trustedSource: presentTrustedSource });
  const trustedPreview = await previewRule();
  const trustedApply = await applyRule();
  state = await fetchRun();
  const trustedResolution = state.conflicts.find((item) => item.conflictId === phone.conflictId).resolution;
  check("explicit trusted source applies as a rule-generated resolution", trustedPreview.resolvableCount >= 1 && trustedApply.appliedCount >= 1 && trustedResolution?.resolutionSource === "rule" && trustedResolution?.chosenSource === presentTrustedSource);

  await configureRule({ field: "Balance", strategy: "prefer_trusted_source", trustedSource: "B" });
  const manualPreview = await previewRule();
  const manualApply = await applyRule();
  state = await fetchRun();
  check("manual resolution takes precedence over a targeted bulk rule", manualPreview.skippedManualCount >= 1 && manualApply.skippedCount >= 1 && state.conflicts.find((item) => item.conflictId === balance.conflictId).resolution?.resolutionSource === "manual");

  await clickResolution(updated, "Clear resolution", "DELETE");
  await configureRule({ field: "Updated at", strategy: "prefer_newest", timestampField: "Updated at" });
  const newestPreview = await previewRule();
  const newestApply = await applyRule();
  state = await fetchRun();
  const developmentNewestItem = newestPreview.items.find((item) => item.conflictId === updated.conflictId);
  const expectedNewest = Date.parse(updated.aValue) > Date.parse(updated.bValue) ? "A" : "B";
  const developmentNewestResolution = state.conflicts.find((item) => item.conflictId === updated.conflictId).resolution;
  check("prefer newest uses parsed development-fixture business timestamps", developmentNewestItem?.outcome === "would_resolve" && newestApply.appliedCount >= 1 && developmentNewestResolution?.chosenSource === expectedNewest && developmentNewestResolution?.resolutionSource === "rule");

  await clickResolution(statusEqual, "Clear resolution", "DELETE");
  await configureRule({ field: "Status", strategy: "prefer_newest", timestampField: "Updated at" });
  const equalPreview = await previewRule();
  const equalApply = await applyRule();
  const equalItem = equalPreview.items.find((item) => item.conflictId === statusEqual.conflictId);
  check("equal timestamp instants remain unresolved instead of inventing a winner", equalItem?.outcome === "unresolved" && equalItem.reasonCode === "timestamps_equal" && equalApply.unresolvedCount >= 1 && (await fetchRun()).conflicts.find((item) => item.conflictId === statusEqual.conflictId).resolution === null);

  state = await fetchRun();
  for (const conflict of state.conflicts.filter((item) => !item.resolution && item.conflictId !== statusEqual.conflictId)) {
    const candidate = state.candidates.find((item) => item.candidateId === conflict.candidateId);
    conflict.aRowId = candidate.aRowId;
    conflict.bRowId = candidate.bRowId;
    await clickResolution(conflict, "Use A");
  }
  await clickResolution(updated, "Keep both");
  state = await fetchRun();
  check("KEEP BOTH remains the effective final representation after an explicit change", state.conflicts.find((item) => item.conflictId === updated.conflictId).resolution?.strategy === "keep_both");

  await screenshot("survivorship-blocked.png");
  const layout = await page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    policyWidth: document.querySelector(".policy-panel")?.getBoundingClientRect().width ?? 0,
    viewportWidth: document.documentElement.clientWidth,
    visibleSourceLabels: [...document.querySelectorAll(".conflict-values small")].filter((node) => node.textContent?.includes("Dataset")).length,
  }));
  report.layout = layout;
  check("desktop survivorship layout has no horizontal page overflow or clipped policy panel", layout.horizontalOverflow <= 1 && layout.policyWidth <= layout.viewportWidth);
  check("A and B source values are visibly labeled rather than color-only", layout.visibleSourceLabels >= 2);
  check("manual and rule-generated badges are visibly distinct", await page.getByText(/manual · use b/i).first().isVisible() && await page.getByText(/rule · prefer trusted source/i).first().isVisible());
  check("KEEP BOTH does not visually imply a selected source", await conflictCard(updated).getByText(/Both source values retained in dedicated A\/B output columns/).isVisible());

  await page.getByRole("button", { name: "Continue to exports" }).click();
  await page.getByRole("heading", { name: "Report everything. Trust only what is ready." }).waitFor();
  const trustedButton = page.getByRole("button", { name: "Download trusted merged output" });
  check("trusted export is visibly blocked while a required conflict is unresolved", await trustedButton.isDisabled() && await page.getByText(/Trusted export blocked/).isVisible());
  const blockedResponse = await page.evaluate(async (id) => {
    const response = await fetch(`/api/runs/${id}/trusted-export`);
    return { status: response.status, body: await response.json() };
  }, runId);
  check("the trusted-export API also rejects the unresolved run truthfully", blockedResponse.status === 409 && blockedResponse.body.error?.code === "trusted_export_not_ready");
  const reconciliationDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download reconciliation report" }).click();
  const reconciliation = await reconciliationDownload;
  const reconciliationPath = join(artifactRoot, "reconciliation-unresolved.csv");
  await reconciliation.saveAs(reconciliationPath);
  const reconciliationCsv = await readFile(reconciliationPath, "utf8");
  check("reconciliation report remains downloadable with unresolved provenance", reconciliationCsv.includes("unresolved") && reconciliationCsv.includes("reconciliation-export-v3.0.0"));

  await page.getByRole("button", { name: "Review conflicts" }).click();
  await clickResolution(statusEqual, "Use A");
  state = await fetchRun();
  check("resolving the last required conflict makes trusted readiness true", state.trustedExportReadiness.ready === true && state.trustedExportReadiness.unresolvedConflictCount === 0 && state.trustedExportReadiness.unresolvedIdentityCount === 0);

  await page.getByRole("button", { name: "Back to results" }).click();
  await page.getByRole("button", { name: "Open review workspace" }).click();
  await page.getByRole("heading", { name: "Resolve identity uncertainty." }).waitFor();
  check("identity undo is visibly blocked by dependent field resolutions", await page.getByText(/Undo blocked:.*dependent field resolution/i).isVisible());

  await page.getByRole("button", { name: "Resolve values separately" }).click();
  await page.getByRole("button", { name: "Continue to exports" }).click();
  check("trusted export visibly becomes ready", await page.getByText("Ready", { exact: true }).isVisible() && !(await trustedButton.isDisabled()));
  const trustedDownload = page.waitForEvent("download");
  await trustedButton.click();
  const trusted = await trustedDownload;
  const trustedPath = join(artifactRoot, "trusted-merged.csv");
  await trusted.saveAs(trustedPath);
  const trustedCsv = await readFile(trustedPath, "utf8");
  check("trusted CSV has deterministic KEEP BOTH columns and resolution marker", trustedCsv.includes("Updated at__A") && trustedCsv.includes("Updated at__B") && trustedCsv.includes("keep_both"));
  check("trusted CSV preserves source-only A and B provenance", trustedCsv.includes("source_only_a") && trustedCsv.includes("source_only_b"));
  check("trusted CSV contains run/source/policy/export provenance", trustedCsv.includes(sourceHashesBefore[0]) && trustedCsv.includes(sourceHashesBefore[1]) && trustedCsv.includes("trusted-merged-export-v2.0.0"));
  check("development trusted CSV contains no unguarded formula-leading cells", !/(^|\r?\n|,)[=+\-@]/m.test(trustedCsv));

  const manifestDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download provenance manifest" }).click();
  const manifestDownload = await manifestDownloadPromise;
  const manifestPath = join(artifactRoot, "run-manifest.json");
  await manifestDownload.saveAs(manifestPath);
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  const stableArtifacts = await page.evaluate(async (id) => {
    const [reportOne, reportTwo, trustedOne, trustedTwo, manifestOne, manifestTwo] = await Promise.all([
      fetch(`/api/runs/${id}/export`).then((response) => response.text()),
      fetch(`/api/runs/${id}/export`).then((response) => response.text()),
      fetch(`/api/runs/${id}/trusted-export`).then((response) => response.text()),
      fetch(`/api/runs/${id}/trusted-export`).then((response) => response.text()),
      fetch(`/api/runs/${id}/manifest`).then((response) => response.text()),
      fetch(`/api/runs/${id}/manifest`).then((response) => response.text()),
    ]);
    return { reportOne, reportTwo, trustedOne, trustedTwo, manifestOne, manifestTwo };
  }, runId);
  check("unchanged authoritative state re-exports byte-identical artifacts",
    stableArtifacts.reportOne === stableArtifacts.reportTwo
    && stableArtifacts.trustedOne === stableArtifacts.trustedTwo
    && stableArtifacts.manifestOne === stableArtifacts.manifestTwo);
  const reconciliationArtifact = manifest.export.artifacts.find((artifact) => artifact.kind === "reconciliation_report");
  const trustedArtifact = manifest.export.artifacts.find((artifact) => artifact.kind === "trusted_merged_output");
  check("manifest hashes match exact reconciliation and trusted bytes",
    reconciliationArtifact?.sha256 === createHash("sha256").update(stableArtifacts.reportOne).digest("hex")
    && trustedArtifact?.sha256 === createHash("sha256").update(stableArtifacts.trustedOne).digest("hex"));
  check("manifest retains source, mapping, candidate, matcher, identity, and survivorship provenance",
    manifest.manifestVersion === "run-manifest-v1.0.0"
    && manifest.sourceDatasets.A.sha256 === sourceHashesBefore[0]
    && manifest.sourceDatasets.B.sha256 === sourceHashesBefore[1]
    && manifest.semanticMapping.mappingVersion === "confirmed-mappings-v1"
    && manifest.candidateGeneration.candidateEngineVersion === "candidate-engine-v0.3.0"
    && manifest.matcher.matcherVersion === "explainable-matcher-v0.2.0"
    && manifest.identity.humanSameCount >= 1
    && manifest.survivorship.keepBothCount >= 1);
  check("ordinary run manifest excludes hidden synthetic truth, prompts, secrets, and server paths",
    !/canonicalEntityId|groundTruth|corruptionProvenance|OPENAI_API_KEY|developerPrompt|[A-Z]:\\/i.test(manifestText)
    && manifest.evaluation.applicable === false);

  report.developmentRunId = runId;
  await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await page.getByLabel("Dataset A CSV").setInputFiles(deterministicA);
  await page.getByLabel("Dataset B CSV").setInputFiles(deterministicB);
  const deterministicUpload = page.waitForResponse((response) => response.request().method() === "POST" && /\/datasets\/B$/.test(response.url()));
  await page.getByRole("button", { name: "Upload & profile" }).click();
  runId = new URL((await deterministicUpload).url()).pathname.split("/")[3];
  report.deterministicRunId = runId;
  await page.getByRole("button", { name: "Map corresponding fields" }).click();
  const deterministicMappings = [
    ["Organization", "vendor_name", "organization", "identity", "text"],
    ["Email", "contact_email", "email_address", "identity", "email"],
    ["Status", "account_status", "status", "comparison", "text"],
    ["Updated at", "updated_at", "last_updated", "comparison", "date"],
  ];
  for (let index = 0; index < deterministicMappings.length; index += 1) await page.getByRole("button", { name: "+ Add manual mapping" }).click();
  const deterministicRows = page.locator(".mapping-row");
  for (let index = 0; index < deterministicMappings.length; index += 1) {
    const [label, aColumn, bColumn, role, normalizer] = deterministicMappings[index];
    const row = deterministicRows.nth(index);
    await row.getByLabel("Mapping label").fill(label);
    await row.getByLabel("Dataset A column").selectOption(aColumn);
    await row.getByLabel("Dataset B column").selectOption(bColumn);
    await row.getByLabel("Mapping role").selectOption(role);
    await row.getByLabel("Normalizer").selectOption(normalizer);
  }
  const deterministicMatch = page.waitForResponse((response) => response.request().method() === "POST" && /\/match$/.test(response.url()));
  await page.getByRole("button", { name: "Save confirmed mappings & run matcher" }).click();
  check("purpose-built ISO/formula fixture also traversed React, Fastify, and Python", (await deterministicMatch).status() === 200);
  const deterministicRun = await fetchRun();
  assert(deterministicRun.reviewProgress.remaining === 0 && deterministicRun.conflicts.length === 2, "Expected one auto-match with two comparison conflicts.");
  await page.getByRole("button", { name: /View field conflicts/ }).click();
  await configureRule({ field: "Status", strategy: "prefer_newest", timestampField: "Updated at" });
  const isoNewestPreview = await previewRule();
  const isoNewestApply = await applyRule();
  let deterministicState = await fetchRun();
  const formulaConflict = deterministicState.conflicts.find((conflict) => conflict.label === "Status");
  const timestampConflict = deterministicState.conflicts.find((conflict) => conflict.label === "Updated at");
  const deterministicCandidate = deterministicState.candidates.find((candidate) => candidate.candidateId === formulaConflict.candidateId);
  formulaConflict.aRowId = deterministicCandidate.aRowId;
  formulaConflict.bRowId = deterministicCandidate.bRowId;
  timestampConflict.aRowId = deterministicCandidate.aRowId;
  timestampConflict.bRowId = deterministicCandidate.bRowId;
  const formulaResolution = deterministicState.conflicts.find((conflict) => conflict.conflictId === formulaConflict.conflictId).resolution;
  check("valid ISO timestamps choose the strictly newer Dataset A value", isoNewestPreview.resolvableCount === 1 && isoNewestApply.appliedCount === 1 && formulaResolution?.chosenSource === "A" && formulaResolution?.chosenValue === "=ACTIVE");
  await clickResolution(timestampConflict, "Use A");
  deterministicState = await fetchRun();
  check("the deterministic fixture becomes trusted-ready without inventing values", deterministicState.trustedExportReadiness.ready === true);
  await page.getByRole("button", { name: "Continue to exports" }).click();
  const formulaDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download trusted merged output" }).click();
  const formulaDownload = await formulaDownloadPromise;
  const formulaPath = join(artifactRoot, "trusted-newest-formula.csv");
  await formulaDownload.saveAs(formulaPath);
  const formulaCsv = await readFile(formulaPath, "utf8");
  check("formula-leading selected values are neutralized in trusted CSV", formulaCsv.includes("'=ACTIVE") && !/(^|\r?\n|,)=ACTIVE/m.test(formulaCsv));
  await screenshot("newest-formula-trusted.png");

  const sourceHashesAfter = [await digest(sourceA), await digest(sourceB)];
  report.sourceHashesBefore = sourceHashesBefore;
  report.sourceHashesAfter = sourceHashesAfter;
  check("Dataset A and B remain byte-identical", JSON.stringify(sourceHashesBefore) === JSON.stringify(sourceHashesAfter));
  check("rendered walkthrough produced no browser console errors", report.browserConsoleErrors.length === 0);
  report.expectedHttpErrors = report.browserHttpErrors.filter((entry) => entry.startsWith("409 POST") || entry.startsWith("409 GET"));
  check("the only HTTP errors were deliberate stale-preview and trusted-export safety checks", report.browserHttpErrors.length === 2 && report.expectedHttpErrors.length === 2);

  await screenshot("trusted-export-ready.png");
  report.status = "PASS";
  await writeFile(join(artifactRoot, "sw008-visible-closeout.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = "FAIL";
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  await screenshot("failure.png").catch(() => undefined);
  await writeFile(join(artifactRoot, "sw008-visible-closeout.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
