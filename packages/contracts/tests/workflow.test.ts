import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  DatasetProfileSchema,
  ManualMappingSchema,
  MATCHER_VERSION,
  WORKFLOW_CONTRACT_VERSION,
} from "../src/index.js";

describe("SW-003 workflow contract", () => {
  it("keeps language-neutral version and matcher literals synchronized", async () => {
    const path = new URL("../schemas/workflow/1.0.0.json", import.meta.url);
    const schema = JSON.parse(await readFile(path, "utf8")) as {
      "x-contract-version": string;
      $defs: { matcherVersion: { const: string } };
    };
    expect(schema["x-contract-version"]).toBe(WORKFLOW_CONTRACT_VERSION);
    expect(schema.$defs.matcherVersion.const).toBe(MATCHER_VERSION);
  });

  it("rejects extra fields and invalid mapping roles", () => {
    expect(ManualMappingSchema.safeParse({
      mappingId: "m1", label: "Name", aColumn: "name", bColumn: "organization",
      role: "winner", normalizer: "text",
    }).success).toBe(false);
  });

  it("classifies shared manual-mapping examples with Zod", async () => {
    const path = new URL("../examples/workflow/1.0.0.json", import.meta.url);
    const examples = JSON.parse(await readFile(path, "utf8")) as {
      manualMappings: { valid: { name: string; value: unknown }[]; invalid: { name: string; value: unknown }[] };
    };
    for (const example of examples.manualMappings.valid) {
      expect(ManualMappingSchema.safeParse(example.value).success, example.name).toBe(true);
    }
    for (const example of examples.manualMappings.invalid) {
      expect(ManualMappingSchema.safeParse(example.value).success, example.name).toBe(false);
    }
  });

  it("validates a bounded dataset profile", () => {
    expect(DatasetProfileSchema.parse({
      contractVersion: "1.0.0", datasetId: "dataset-a", side: "A", originalFilename: "a.csv",
      sha256: "a".repeat(64), rowCount: 1,
      columns: [{ name: "name", inferredType: "string", nullCount: 0, nullRate: 0, distinctCount: 1, distinctRate: 1, samples: ["Acme"] }],
    }).rowCount).toBe(1);
  });
});
