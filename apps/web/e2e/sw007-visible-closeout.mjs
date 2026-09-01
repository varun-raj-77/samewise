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
const artifactRoot = resolve(root, ".samewise-data/acceptance/sw-007");
await mkdir(artifactRoot, { recursive: true });

const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const sourceHashesBefore = [await digest(sourceA), await digest(sourceB)];
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

const browser = await chromium.launch({
  headless: process.env.SAMEWISE_HEADLESS === "1",
  slowMo: process.env.SAMEWISE_HEADLESS === "1" ? 0 : 35,
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
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
  if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) {
    report.browserHttpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
  }
});

let runId;
const fetchRun = async () => {
  const response = await fetch(`http://127.0.0.1:3000/api/runs/${runId}`);
  assert(response.ok, `GET run failed with ${response.status}`);
  return response.json();
};
const selectReviewItem = async (aRowId, filter = "unresolved") => {
  await page.getByLabel("Filter review queue").selectOption(filter);
  const search = page.getByRole("searchbox", { name: "Search review queue" });
  await search.fill(aRowId);
  const row = page.getByTestId("review-queue-row").filter({ hasText: aRowId });
  await row.click();
  await search.fill("");
  await page.locator(".case-heading h2").focus();
};
const screenshot = async (name) => {
  const path = join(artifactRoot, name);
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push(path);
};

try {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Start with two messy CSV files." }).waitFor();
  check("Samewise opened in the rendered React application");

  await page.getByLabel("Dataset A CSV").setInputFiles(sourceA);
  await page.getByLabel("Dataset B CSV").setInputFiles(sourceB);
  const uploaded = page.waitForResponse((response) => response.request().method() === "POST" && /\/datasets\/B$/.test(response.url()));
  await page.getByRole("button", { name: "Upload & profile" }).click();
  const uploadResponse = await uploaded;
  runId = new URL(uploadResponse.url()).pathname.split("/")[3];
  report.runId = runId;
  await page.getByRole("heading", { name: "Know what arrived." }).waitFor();
  check("both normal development CSV inputs were uploaded and profiled", uploadResponse.status() === 201);
  check("profile counts are visibly factual", await page.getByText(/23 rows · SHA-256/).isVisible() && await page.getByText(/22 rows · SHA-256/).isVisible());

  await page.getByRole("button", { name: "Map corresponding fields" }).click();
  for (let index = 0; index < mappings.length; index += 1) {
    await page.getByRole("button", { name: "+ Add manual mapping" }).click();
  }
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
  check("eight identity mappings and three post-identity comparison mappings were confirmed", await page.locator(".mapping-row.identity").count() === 8 && await page.locator(".mapping-row.comparison").count() === 3);

  const matchedResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/match$/.test(response.url()));
  await page.getByRole("button", { name: "Save confirmed mappings & run matcher" }).click();
  check("the real Fastify API completed the Python matcher request", (await matchedResponse).status() === 200);
  await page.getByRole("heading", { name: "Evidence first, uncertainty visible." }).waitFor();
  const matched = await fetchRun();
  report.initialSummary = matched.summary;
  report.initialProgress = matched.reviewProgress;
  check("real matcher summary is 11 matched, 8 needs review, 4 only A, 11 only B", matched.summary.matched === 11 && matched.summary.needsReview === 8 && matched.summary.onlyA === 4 && matched.summary.onlyB === 11);
  check("initial review progress is 0 reviewed, 8 remaining, 0 deferred", matched.reviewProgress.total === 8 && matched.reviewProgress.reviewed === 0 && matched.reviewProgress.remaining === 8 && matched.reviewProgress.deferred === 0);

  const ambiguous = matched.reviewQueue.find((item) => item.state === "needs_review" && item.candidateCount >= 2 && matched.candidates
    .filter((candidate) => candidate.aRowId === item.aRowId)
    .some((candidate) => matched.mappings.filter((mapping) => mapping.role === "comparison")
      .some((mapping) => candidate.aRecord[mapping.aColumn] !== candidate.bRecord[mapping.bColumn])));
  assert(ambiguous, "Expected a review item with an alternate and a comparison conflict.");
  const intended = matched.candidates.find((candidate) => candidate.candidateId === ambiguous.topCandidateId);
  const alternate = matched.candidates.find((candidate) => candidate.aRowId === ambiguous.aRowId && candidate.rank === 2);
  assert(intended && alternate, "Expected intended and alternate candidates.");
  report.ambiguousCase = { aRowId: ambiguous.aRowId, intendedBRowId: intended.bRowId, alternateBRowId: alternate.bRowId, candidateCount: ambiguous.candidateCount };
  report.fixtureCollisionCount = matched.reviewQueue.filter((item) => item.collision).length;

  await page.getByRole("button", { name: "Open review workspace" }).click();
  await page.getByRole("heading", { name: "Resolve identity uncertainty." }).waitFor();
  check("review progress and queue are visible", await page.getByLabel("Overall review progress").isVisible() && await page.getByRole("heading", { name: "Review queue" }).isVisible());
  check("shortcut help is present and labels S, D, E, U, J/K, and 1–3", await page.getByRole("button", { name: /Keyboard shortcuts: S same, D different, E defer, U undo, J and K navigate, 1 through 3 select candidates/ }).isVisible());

  await selectReviewItem(ambiguous.aRowId);
  await page.getByRole("heading", { name: `Are ${ambiguous.aRowId} and ${intended.bRowId} the same entity?` }).waitFor();
  check("selected case shows side-by-side mapped identity evidence", await page.getByRole("heading", { name: "Mapped identity evidence" }).isVisible() && await page.locator(".field-evidence").first().isVisible());
  await page.locator(".field-evidence details").first().getByText("Feature detail and matcher explanation").click();
  check("matcher-derived feature detail is readable", await page.locator(".field-evidence details[open]").first().isVisible());
  await page.locator(".raw-records").getByText("All raw source fields").click();
  check("all raw A and B source fields can be inspected", await page.getByRole("heading", { name: `Dataset A · ${ambiguous.aRowId}` }).isVisible() && await page.getByRole("heading", { name: `Dataset B · ${intended.bRowId}` }).isVisible());

  const beforeCandidateSwitch = await fetchRun();
  await page.getByRole("button", { name: new RegExp(`Select candidate rank 2, ${alternate.bRowId}`) }).click();
  await page.getByRole("heading", { name: `Are ${ambiguous.aRowId} and ${alternate.bRowId} the same entity?` }).waitFor();
  const afterCandidateSwitch = await fetchRun();
  check("switching to candidate rank 2 creates no identity decision", afterCandidateSwitch.decisions.length === beforeCandidateSwitch.decisions.length);
  await page.getByRole("button", { name: new RegExp(`Select candidate rank 1, ${intended.bRowId}`) }).click();

  const beforeTyping = await fetchRun();
  const search = page.getByRole("searchbox", { name: "Search review queue" });
  await search.focus();
  await page.keyboard.type("sde");
  await page.getByLabel("Sort review queue").focus();
  await page.keyboard.press("s");
  await page.keyboard.press("d");
  await page.keyboard.press("e");
  const afterTyping = await fetchRun();
  check("S, D, and E shortcuts do not fire while focus is in an input or select", afterTyping.decisions.length === beforeTyping.decisions.length && afterTyping.reviewProgress.deferred === beforeTyping.reviewProgress.deferred);
  await search.fill("");
  await page.getByRole("heading", { name: `Are ${ambiguous.aRowId} and ${intended.bRowId} the same entity?` }).focus();

  const sameResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && /\/decisions$/.test(response.url()));
  await page.keyboard.press("s");
  const sameResponse = await sameResponsePromise;
  const afterSame = await sameResponse.json();
  const sameConflicts = afterSame.conflicts.filter((conflict) => conflict.candidateId === intended.candidateId);
  const expectedAfterSame = afterSame.reviewQueue.find((item) => item.state === "needs_review" && item.sourceOrder > ambiguous.sourceOrder)
    ?? afterSame.reviewQueue.find((item) => item.state === "needs_review");
  assert(expectedAfterSame, "Expected an active item after SAME.");
  check("keyboard S records human SAME", afterSame.decisions.some((decision) => decision.candidateId === intended.candidateId && decision.humanDecision === "same_entity"));
  check("SAME creates field conflicts afterward", sameConflicts.length > 0);
  check("SAME creates zero automatic field resolutions", sameConflicts.every((conflict) => conflict.resolution === null));
  await page.getByRole("heading", { name: new RegExp(`^Are ${expectedAfterSame.aRowId} and `) }).waitFor();
  check("SAME auto-advances predictably and keeps focus on the next decision heading", await page.getByRole("heading", { name: new RegExp(`^Are ${expectedAfterSame.aRowId} and `) }).evaluate((element) => element === document.activeElement));

  await selectReviewItem(ambiguous.aRowId, "all");
  await page.getByRole("heading", { name: `Are ${ambiguous.aRowId} and ${intended.bRowId} the same entity?` }).waitFor();
  check("reopening a reviewed SAME item keeps the human-confirmed candidate selected", true);
  check("the review UI reports separately created unresolved conflicts", (await page.locator(".post-identity-conflicts").textContent())?.includes("created after SAME"));
  await screenshot("review-after-same.png");

  const differentItem = afterSame.reviewQueue.find((item) => item.state === "needs_review" && item.aRowId !== ambiguous.aRowId);
  assert(differentItem, "Expected a second active review item.");
  await selectReviewItem(differentItem.aRowId, "unresolved");
  const differentCandidate = afterSame.candidates.find((candidate) => candidate.candidateId === differentItem.topCandidateId);
  assert(differentCandidate, "Expected the second item's top candidate.");
  const differentResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && /\/decisions$/.test(response.url()));
  await page.keyboard.press("d");
  const afterDifferent = await (await differentResponsePromise).json();
  check("keyboard D records human DIFFERENT", afterDifferent.decisions.some((decision) => decision.candidateId === differentCandidate.candidateId && decision.humanDecision === "different_entity"));
  check("DIFFERENT creates no field conflicts for that pair", afterDifferent.conflicts.filter((conflict) => conflict.candidateId === differentCandidate.candidateId).length === 0);

  const deferItem = afterDifferent.reviewQueue.find((item) => item.state === "needs_review" && item.aRowId !== ambiguous.aRowId && item.aRowId !== differentItem.aRowId);
  assert(deferItem, "Expected a third active item to defer.");
  await selectReviewItem(deferItem.aRowId, "unresolved");
  const deferResponsePromise = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes(`/review-items/${deferItem.aRowId}`));
  await page.keyboard.press("e");
  const afterDefer = await (await deferResponsePromise).json();
  check("keyboard E defers without creating an identity decision", afterDefer.reviewQueue.find((item) => item.aRowId === deferItem.aRowId)?.state === "deferred" && !afterDefer.decisions.some((decision) => decision.aRowId === deferItem.aRowId));
  await page.getByLabel("Filter review queue").selectOption("unresolved");
  await search.fill(deferItem.aRowId);
  check("deferred item leaves the active unresolved sequence", await page.getByText("No review items match this view.").isVisible());
  await search.fill("");

  await selectReviewItem(deferItem.aRowId, "deferred");
  check("deferred item remains recoverable and visibly marked deferred", await page.locator(".case-heading .state-deferred").isVisible());
  const returnResponsePromise = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes(`/review-items/${deferItem.aRowId}`));
  await page.getByRole("button", { name: "Return to review" }).click();
  const afterReturn = await (await returnResponsePromise).json();
  check("deferred item can return to active review without an identity decision", afterReturn.reviewQueue.find((item) => item.aRowId === deferItem.aRowId)?.state === "needs_review" && afterReturn.reviewProgress.deferred === 0);

  const undoResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && /\/review-undo$/.test(response.url()));
  await page.keyboard.press("u");
  const afterUndo = await (await undoResponsePromise).json();
  check("keyboard U restores the preceding DIFFERENT decision to undecided", !afterUndo.decisions.some((decision) => decision.candidateId === differentCandidate.candidateId) && afterUndo.reviewQueue.find((item) => item.aRowId === differentItem.aRowId)?.state === "needs_review");
  const restoredHeading = page.getByRole("heading", { name: new RegExp(`^Are ${differentItem.aRowId} and `) });
  await restoredHeading.waitFor();
  check("Undo restores focus to the affected identity case", await restoredHeading.evaluate((element) => element === document.activeElement));

  const runBeforeRefresh = await fetchRun();
  const currentUrl = new URL(page.url());
  check("review route carries the process-local run and screen", currentUrl.searchParams.get("run") === runId && currentUrl.searchParams.get("screen") === "review");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Resolve identity uncertainty." }).waitFor();
  const runAfterRefresh = await fetchRun();
  check("refresh recovers the same live run and review progress", runAfterRefresh.runId === runId && JSON.stringify(runAfterRefresh.reviewProgress) === JSON.stringify(runBeforeRefresh.reviewProgress));

  await page.getByLabel("Filter review queue").selectOption("unresolved");
  await page.getByRole("searchbox", { name: "Search review queue" }).fill("");
  await page.getByLabel("Sort review queue").selectOption("source");
  const queueViewport = page.getByTestId("review-queue-viewport");
  const beforeScrollLabels = await page.getByTestId("review-queue-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label")));
  await queueViewport.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await page.waitForTimeout(100);
  const afterScrollRows = page.getByTestId("review-queue-row");
  const afterScrollLabels = await afterScrollRows.evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label")));
  const lastRow = afterScrollRows.last();
  const lastARowId = (await lastRow.getAttribute("aria-label"))?.split(",")[0];
  assert(lastARowId, "Expected a later queue row after scrolling.");
  await lastRow.click();
  check("queue scrolling preserves coherent row selection", beforeScrollLabels.length > 0 && afterScrollLabels.length > 0 && await page.getByRole("heading", { name: new RegExp(`^Are ${lastARowId} and `) }).isVisible());

  const layout = await page.evaluate(() => {
    const root = document.documentElement;
    const queue = document.querySelector(".review-queue")?.getBoundingClientRect();
    const reviewCase = document.querySelector(".review-case")?.getBoundingClientRect();
    const rows = [...document.querySelectorAll(".review-queue-row")].map((row) => row.getBoundingClientRect());
    return {
      horizontalOverflow: root.scrollWidth - root.clientWidth,
      queueCaseOverlap: queue && reviewCase ? queue.right - reviewCase.left : null,
      blankOrOverlappingRows: rows.some((row, index) => row.height <= 0 || (index > 0 && row.top < rows[index - 1].bottom - 1)),
      queueScrollHeight: document.querySelector(".review-queue-viewport")?.scrollHeight ?? 0,
      queueClientHeight: document.querySelector(".review-queue-viewport")?.clientHeight ?? 0,
    };
  });
  report.layout = layout;
  check("normal desktop review has no horizontal page overflow", layout.horizontalOverflow <= 1);
  check("queue and evidence case do not overlap", layout.queueCaseOverlap !== null && layout.queueCaseOverlap <= 1);
  check("virtual rows are neither blank nor overlapping", layout.blankOrOverlappingRows === false);
  check("the fixture queue remains usable as a bounded scroll region", layout.queueScrollHeight >= layout.queueClientHeight);
  check("SAME and survivorship actions remain visually separate", await page.getByRole("button", { name: "Same entity" }).isVisible() && await page.getByText("Identity first. Values second.").first().isVisible());

  if (runAfterRefresh.reviewQueue.some((item) => item.collision)) {
    const collision = runAfterRefresh.reviewQueue.find((item) => item.collision);
    await selectReviewItem(collision.aRowId, "collision");
    check("natural fixture collision warning is visible and non-color-only", await page.getByLabel("Candidate collision warning").isVisible());
    report.collisionVerification = "visible fixture collision";
  } else {
    report.collisionVerification = "no natural organizations-dev-v1 collision; deterministic API/UI tests retained";
  }

  await screenshot("review-route-recovered.png");
  const sourceHashesAfter = [await digest(sourceA), await digest(sourceB)];
  report.sourceHashesBefore = sourceHashesBefore;
  report.sourceHashesAfter = sourceHashesAfter;
  report.finalProgress = runAfterRefresh.reviewProgress;
  check("source fixture hashes remain byte-for-byte unchanged", JSON.stringify(sourceHashesAfter) === JSON.stringify(sourceHashesBefore));
  check("browser produced no unexpected console, page, or HTTP errors", report.browserConsoleErrors.length === 0 && report.browserHttpErrors.length === 0);
  report.status = "PASS";
  await writeFile(join(artifactRoot, "sw007-visible-closeout.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = "FAIL";
  report.error = error instanceof Error ? error.stack : String(error);
  await screenshot("failure.png").catch(() => undefined);
  await writeFile(join(artifactRoot, "sw007-visible-closeout.json"), `${JSON.stringify(report, null, 2)}\n`);
  throw error;
} finally {
  await browser.close();
}
