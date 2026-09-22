import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RunManifestSchema } from "@samewise/contracts";
import { expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { createMatcherRunner } from "../src/matcher-process.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const python = process.platform === "win32"
  ? join(root, "services/matcher/.venv/Scripts/python.exe")
  : join(root, "services/matcher/.venv/bin/python");

it.skipIf(!existsSync(python))("retains the actual Python matcher evidence plan in a product manifest", async () => {
  const previousDirectory = process.cwd();
  const previousPython = process.env.SAMEWISE_PYTHON;
  process.chdir(root);
  process.env.SAMEWISE_PYTHON = python;
  const app = buildApp({ dataRoot: await mkdtemp(join(tmpdir(), "samewise-real-provenance-")), matcher: createMatcherRunner() });
  try {
    const created = (await app.inject({ method: "POST", url: "/api/runs" })).json() as { runId: string };
    for (const [side, bytes] of [["A", "id,name\nA1,Acme Inc\n"], ["B", "id,name\nB1,Acme Inc\n"]] as const) {
      const uploaded = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/datasets/${side}`, headers: { "content-type": "text/csv", "x-file-name": `${side}.csv` }, payload: bytes });
      expect(uploaded.statusCode).toBe(201);
    }
    const mapped = await app.inject({ method: "PUT", url: `/api/runs/${created.runId}/mappings`, payload: { mappings: [{ mappingId: "name", label: "Name", aColumn: "name", bColumn: "name", useForMatching: true, includeInMerge: true, normalizer: "text", semanticFamily: "name_or_title" }] } });
    expect(mapped.statusCode).toBe(200);
    const matched = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/match` });
    expect(matched.statusCode).toBe(200);
    const manifest = RunManifestSchema.parse((await app.inject({ method: "GET", url: `/api/runs/${created.runId}/manifest` })).json());
    expect(manifest.candidateGeneration.candidateConfigAvailability).toBe("retained_in_evidence_plan");
    expect(manifest.candidateGeneration.evidencePlan).toMatchObject({
      version: "evidence-plan-v1.0.0",
      candidateStrategy: { mode: "candidate_engine" },
      mappings: [{ mappingId: "name", semanticFamily: "name_or_title", comparator: "normalized_name_similarity" }],
    });
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
    expect(manifest.candidateGeneration.evidencePlanSha256).toBe(createHash("sha256").update(JSON.stringify(canonical(manifest.candidateGeneration.evidencePlan))).digest("hex"));
    expect(JSON.stringify(manifest.candidateGeneration.evidencePlan)).not.toContain("Acme Inc");
  } finally {
    await app.close();
    process.chdir(previousDirectory);
    if (previousPython === undefined) delete process.env.SAMEWISE_PYTHON;
    else process.env.SAMEWISE_PYTHON = previousPython;
  }
}, 30_000);
