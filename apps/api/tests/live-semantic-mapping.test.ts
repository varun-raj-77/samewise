import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MappingSuggestionResponseSchema, RunViewSchema } from "@samewise/contracts";
import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { evaluateSchemaMappings } from "../src/schema-mapping-evaluation.js";

const liveEnabled = process.env.SAMEWISE_LIVE_OPENAI === "1" && Boolean(process.env.OPENAI_API_KEY);

describe("opt-in live semantic mapping evaluation", () => {
  const app = buildApp({ dataRoot: join(tmpdir(), `samewise-live-${Date.now()}`) });
  afterAll(async () => app.close());

  it.runIf(liveEnabled)("proposes from visible profiles, then evaluates separately against hidden truth", async () => {
    const created = RunViewSchema.parse((await app.inject({ method: "POST", url: "/api/runs" })).json());
    const fixtureRoot = new URL("../../../fixtures/corrupted/organizations/organizations-dev-v1/", import.meta.url);
    for (const [side, filename] of [["A", "dataset_a.csv"], ["B", "dataset_b.csv"]] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/runs/${created.runId}/datasets/${side}`,
        headers: { "content-type": "text/csv", "x-file-name": filename },
        payload: await readFile(new URL(filename, fixtureRoot)),
      });
      expect(response.statusCode).toBe(201);
    }
    const response = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/mapping-suggestions` });
    expect(response.statusCode).toBe(201);
    const proposal = MappingSuggestionResponseSchema.parse(response.json()).proposal;

    const truth = JSON.parse(await readFile(new URL("../../../fixtures/ground-truth/organizations/organizations-dev-v1/schema_mapping.json", import.meta.url), "utf8")) as {
      fields: { dataset_a_column: string; dataset_b_column: string }[];
    };
    const evaluation = evaluateSchemaMappings(
      proposal.suggestions.map((item) => ({ leftColumn: item.leftColumn, rightColumn: item.rightColumn })),
      truth.fields.map((item) => ({ leftColumn: item.dataset_a_column, rightColumn: item.dataset_b_column })),
    );
    console.info(JSON.stringify({
      provenance: proposal.provenance,
      suggestions: proposal.suggestions.map(({ leftColumn, rightColumn, confidence, reason }) => ({ leftColumn, rightColumn, confidence, reason })),
      unmappedLeft: proposal.unmappedLeft,
      unmappedRight: proposal.unmappedRight,
      evaluation,
    }, null, 2));
  }, 60_000);
});
