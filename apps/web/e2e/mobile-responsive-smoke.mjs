import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
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

const artifactDir = resolve(root, ".artifacts/mobile-responsive");
await mkdir(artifactDir, { recursive: true });

const viewports = [
  { name: "360x800", width: 360, height: 800 },
  { name: "390x844", width: 390, height: 844 },
  { name: "412x915", width: 412, height: 915 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1440x900", width: 1440, height: 900 },
];
const primaryViewport = viewports[1];
const fieldTypes = [
  "source_local_identifier", "persistent_identifier", "name_or_title", "address", "geography", "geography",
  "geography", "email", "phone", "contact_person", "date_or_timestamp",
];
const normalizers = ["text", "text", "text", "text", "text", "text", "text", "email", "phone", "text", "date"];
const checks = [];
const check = (name, condition = true) => { assert(condition, name); checks.push(name); };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: primaryViewport });

async function auditScreen(name) {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(40);
    const dimensions = await page.evaluate(() => ({
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    check(`${name} has no horizontal document overflow at ${viewport.name}`, dimensions.documentScrollWidth <= dimensions.documentClientWidth);
    check(`${name} has no horizontal body overflow at ${viewport.name}`, dimensions.bodyScrollWidth <= dimensions.bodyClientWidth);
    if (viewport.name === "390x844" || viewport.name === "1440x900") {
      await page.screenshot({ path: resolve(artifactDir, `${name}-${viewport.name}.png`) });
    }
  }
  await page.setViewportSize(primaryViewport);
}

try {
  await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Upload datasets" }).waitFor();

  check("permanent desktop sidebar is hidden on phone", await page.locator(".app-sidebar").isHidden());
  check("compact mobile progress identifies Upload", await page.getByLabel("Step 1 of 5, Upload").isVisible());
  const menuButton = page.getByRole("button", { name: "Menu" });
  await menuButton.click();
  check("mobile menu opens", await page.getByRole("dialog", { name: "Samewise menu" }).isVisible());
  check("workflow navigation exposes the current Upload step", await page.getByRole("button", { name: /Upload Current step/ }).isVisible());
  await page.getByRole("button", { name: "Close menu" }).click();
  check("mobile menu closes with its close control", await page.getByRole("dialog", { name: "Samewise menu" }).isHidden());
  await menuButton.click();
  await page.keyboard.press("Escape");
  check("mobile menu closes with Escape", await page.getByRole("dialog", { name: "Samewise menu" }).isHidden());

  const cards = page.locator(".file-picker");
  const cardA = await cards.nth(0).boundingBox();
  const cardB = await cards.nth(1).boundingBox();
  check("Dataset A and B upload cards stack on phone", Boolean(cardA && cardB && cardB.y > cardA.y + cardA.height));
  check("mobile upload language favors Choose CSV", await page.getByText("Choose CSV").first().isVisible());
  check("Try sample data is reachable", await page.getByRole("button", { name: "Try sample data" }).isVisible());
  await auditScreen("upload");

  const uploaded = page.waitForResponse((response) => response.request().method() === "POST" && /\/datasets\/B$/.test(response.url()));
  await page.getByRole("button", { name: "Try sample data" }).click();
  check("sample pair used the normal upload path", (await uploaded).status() === 201);
  await page.getByRole("heading", { name: "Your files are ready." }).waitFor();
  await page.getByRole("button", { name: "Set up matching" }).click();

  for (let index = 0; index < fieldTypes.length; index += 1) {
    await page.getByRole("button", { name: "+ Add manual mapping" }).click();
    await page.locator(".mapping-row").nth(index).waitFor();
  }
  const rows = page.locator(".mapping-row");
  check("all sample mappings are available on mobile", await rows.count() === 11);
  for (let index = 0; index < fieldTypes.length; index += 1) {
    const row = rows.nth(index);
    await row.getByLabel("Field type").selectOption(fieldTypes[index]);
    await row.getByLabel("Normalizer").selectOption(normalizers[index]);
  }
  await rows.nth(0).getByLabel("Use to match").uncheck();
  await rows.nth(0).getByLabel("Keep in result").uncheck();
  await rows.nth(1).getByLabel("Keep in result").uncheck();
  await rows.nth(10).getByLabel("Use to match").uncheck();
  const firstRow = await rows.first().boundingBox();
  check("mapping cards fit the phone content width", Boolean(firstRow && firstRow.x >= 16 && firstRow.x + firstRow.width <= primaryViewport.width - 16));
  await auditScreen("match-setup");

  const matched = page.waitForResponse((response) => response.request().method() === "POST" && /\/match$/.test(response.url()));
  await page.getByRole("button", { name: "Confirm setup & run matching" }).click();
  check("the frozen matcher completed in the mobile workflow", (await matched).status() === 200);
  await page.getByRole("heading", { name: "Matching complete." }).waitFor();
  check("results keep Review uncertain matches dominant", await page.getByRole("button", { name: "Review 1 uncertain match" }).isVisible());
  check("all four result summary categories render", await page.locator(".summary-grid .metric").count() === 4);
  await auditScreen("results");

  await page.getByRole("button", { name: "Review 1 uncertain match" }).click();
  await page.getByRole("heading", { name: "Could these be the same entity?" }).waitFor();
  await page.getByRole("heading", { name: "Could A-1024 and B-2024 be the same entity?" }).waitFor();
  const firstEvidence = page.locator(".field-evidence").first();
  const evidenceA = await firstEvidence.locator(":scope > div").nth(1).boundingBox();
  const evidenceB = await firstEvidence.locator(":scope > div").nth(2).boundingBox();
  check("review Dataset A and B values stack on phone", Boolean(evidenceA && evidenceB && evidenceB.y > evidenceA.y));
  const sameBox = await page.getByRole("button", { name: "Same entity" }).boundingBox();
  const differentBox = await page.getByRole("button", { name: "Different entities" }).boundingBox();
  check("Same and Different actions are touch friendly", Boolean(sameBox && differentBox && sameBox.height >= 44 && differentBox.height >= 44));
  await auditScreen("review");

  await page.getByRole("button", { name: "Same entity" }).click();
  await page.getByRole("button", { name: "Continue to Merge values" }).click();
  await page.getByRole("heading", { name: "Choose which values to keep." }).waitFor();
  const mergeRows = page.locator(".merge-field-row");
  check("merge plan renders field cards", await mergeRows.count() > 0);
  const mergeBox = await mergeRows.first().boundingBox();
  check("merge cards fit the phone content width", Boolean(mergeBox && mergeBox.x >= 16 && mergeBox.x + mergeBox.width <= primaryViewport.width - 16));
  await auditScreen("merge-values");

  const ruleSelectors = page.locator('select[aria-label^="Rule for"]');
  for (let index = 0; index < await ruleSelectors.count(); index += 1) await ruleSelectors.nth(index).selectOption("keep_both");
  await page.getByRole("button", { name: "Preview merge plan" }).click();
  await page.getByRole("heading", { name: "Merge plan preview" }).waitFor();
  check("merge preview remains a separate explicit action", await page.getByText("Nothing changes until you apply this plan.").isVisible());
  await page.getByRole("button", { name: "Apply merge plan" }).click();
  await page.getByRole("button", { name: "Continue to Export" }).waitFor();
  await page.getByRole("button", { name: "Continue to Export" }).click();
  await page.getByRole("heading", { name: "Download reconciled data." }).waitFor();
  const exportCta = await page.getByRole("button", { name: "Download reconciled data" }).boundingBox();
  check("Export CTA is touch friendly and fits", Boolean(exportCta && exportCta.height >= 44 && exportCta.x + exportCta.width <= primaryViewport.width - 16));
  await auditScreen("export");

  await menuButton.click();
  await page.getByRole("button", { name: /Match setup Completed/ }).click();
  await page.getByRole("heading", { name: "Set up matching." }).waitFor();
  check("permitted earlier workflow navigation works and closes the drawer", await page.getByRole("dialog", { name: "Samewise menu" }).isHidden());

  console.log(JSON.stringify({ status: "PASS", checkCount: checks.length, checks, screenshots: artifactDir }, null, 2));
} finally {
  await browser.close();
}
