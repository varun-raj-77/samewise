import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvaluationCatalogSchema, EvaluationErrorPageSchema } from "@samewise/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

describe("SW-009 evaluation API", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it("serves cached snapshot metadata and paged evaluation-only errors", async () => {
    const app = buildApp(); apps.push(app);
    const catalogResponse = await app.inject({ method: "GET", url: "/api/evaluations" });
    const catalog = EvaluationCatalogSchema.parse(catalogResponse.json());
    const current = catalog.snapshots.find((snapshot) => snapshot.provenance.matcherVersion === "explainable-matcher-v0.2.0")!;
    expect(catalogResponse.statusCode).toBe(200);
    const errorsResponse = await app.inject({ method: "GET", url: `/api/evaluations/${current.id}/errors?type=candidate_misses&offset=0&limit=2` });
    const page = EvaluationErrorPageSchema.parse(errorsResponse.json());
    expect(page.total).toBe(13);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.evaluationOnlyTruth.notice).toContain("Evaluation-only truth");
  });

  it("keeps normal product startup independent from evaluation and truth artifacts", async () => {
    const unavailable = join(await mkdtemp(join(tmpdir(), "samewise-no-truth-")), "missing-evaluation");
    const app = buildApp({ evaluationRoot: unavailable }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/runs" });
    expect(response.statusCode).toBe(201);
    expect(response.json().stage).toBe("upload");
  });

  it("caps large error payloads instead of returning every evidence card", async () => {
    const source = buildApp(); apps.push(source);
    const catalog = EvaluationCatalogSchema.parse((await source.inject({ method: "GET", url: "/api/evaluations" })).json());
    const current = catalog.snapshots.find((snapshot) => snapshot.provenance.matcherVersion === "explainable-matcher-v0.2.0")!;
    const seedPage = EvaluationErrorPageSchema.parse((await source.inject({ method: "GET", url: `/api/evaluations/${current.id}/errors?type=candidate_misses&limit=1` })).json());
    const root = await mkdtemp(join(tmpdir(), "samewise-many-errors-"));
    await mkdir(join(root, current.id));
    await writeFile(join(root, "catalog.json"), JSON.stringify(catalog));
    await writeFile(join(root, current.id, "errors.json"), JSON.stringify(Array.from({ length: 250 }, (_, index) => ({ ...seedPage.items[0], id: `large-error-${index}` }))));
    const app = buildApp({ evaluationRoot: root }); apps.push(app);
    const response = await app.inject({ method: "GET", url: `/api/evaluations/${current.id}/errors?type=candidate_misses&limit=1000` });
    const page = EvaluationErrorPageSchema.parse(response.json());
    expect(page.total).toBe(250);
    expect(page.limit).toBe(100);
    expect(page.items).toHaveLength(100);
  });
});
