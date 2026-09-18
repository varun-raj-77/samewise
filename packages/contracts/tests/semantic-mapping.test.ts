import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  MappingSuggestionDecisionSchema,
  NormalizationHintSchema,
  SEMANTIC_MAPPING_CONTRACT_VERSION,
  SemanticMappingModelOutputSchema,
} from "../src/index.js";

describe("SW-004 semantic mapping contract", () => {
  it("keeps the canonical JSON Schema version and controlled hint enum synchronized", async () => {
    const schema = JSON.parse(await readFile(new URL("../schemas/semantic-mapping/2.0.0.json", import.meta.url), "utf8")) as {
      "x-contract-version": string;
      properties: { mappings: { items: { properties: { normalizationHints: { items: { enum: string[] } } } } } };
    };
    expect(schema["x-contract-version"]).toBe(SEMANTIC_MAPPING_CONTRACT_VERSION);
    for (const hint of schema.properties.mappings.items.properties.normalizationHints.items.enum) {
      expect(NormalizationHintSchema.safeParse(hint).success).toBe(true);
    }
  });

  it("rejects free-form fields, arbitrary hints, invalid confidence, and non-finite confidence", () => {
    const base = {
      mappings: [{ leftColumn: "name", rightColumn: "organization", relation: "equivalent", useForMatching: true, includeInMerge: true, sourceSpecific: false, confidence: 0.9, reason: "Same semantic field.", normalizationHints: ["casefold"] }],
      unmappedLeft: [], unmappedRight: [],
    };
    expect(SemanticMappingModelOutputSchema.safeParse(base).success).toBe(true);
    expect(SemanticMappingModelOutputSchema.safeParse({ ...base, mappings: [{ ...base.mappings[0], arbitraryCode: "eval()" }] }).success).toBe(false);
    expect(SemanticMappingModelOutputSchema.safeParse({ ...base, mappings: [{ ...base.mappings[0], normalizationHints: ["run_this_code"] }] }).success).toBe(false);
    expect(SemanticMappingModelOutputSchema.safeParse({ ...base, mappings: [{ ...base.mappings[0], confidence: -0.1 }] }).success).toBe(false);
    expect(SemanticMappingModelOutputSchema.safeParse({ ...base, mappings: [{ ...base.mappings[0], confidence: Number.NaN }] }).success).toBe(false);
  });

  it("requires explicit remap state and prevents an accept from silently editing", () => {
    expect(MappingSuggestionDecisionSchema.safeParse({ decision: "remap" }).success).toBe(false);
    expect(MappingSuggestionDecisionSchema.safeParse({ decision: "accept", finalMapping: {
      mappingId: "m", label: "Name", aColumn: "name", bColumn: "other", useForMatching: true, includeInMerge: false, normalizer: "text",
    } }).success).toBe(false);
  });
});
