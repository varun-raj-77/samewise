import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { evaluateSchemaMappings } from "../src/schema-mapping-evaluation.js";

describe("schema mapping evaluation", () => {
  it("reports exact, incorrect, missed, extra, precision, and recall with explicit denominators", () => {
    const result = evaluateSchemaMappings(
      [
        { leftColumn: "name", rightColumn: "organization" },
        { leftColumn: "phone", rightColumn: "email" },
        { leftColumn: "unexpected", rightColumn: "extra" },
      ],
      [
        { leftColumn: "name", rightColumn: "organization" },
        { leftColumn: "phone", rightColumn: "telephone" },
        { leftColumn: "email", rightColumn: "email_address" },
      ],
    );
    expect(result).toEqual({
      expectedMappingCount: 3,
      proposedMappingCount: 3,
      exactCorrectMappingCount: 1,
      incorrectMappingCount: 1,
      missedExpectedMappingCount: 2,
      extraProposedMappingCount: 1,
      precision: 1 / 3,
      recall: 1 / 3,
    });
  });

  it("can read SW-002 hidden truth only from evaluation test code", async () => {
    const path = new URL("../../../fixtures/ground-truth/organizations/organizations-dev-v1/schema_mapping.json", import.meta.url);
    const truth = JSON.parse(await readFile(path, "utf8")) as { fields: { dataset_a_column: string; dataset_b_column: string }[] };
    const expected = truth.fields.map((field) => ({ leftColumn: field.dataset_a_column, rightColumn: field.dataset_b_column }));
    const result = evaluateSchemaMappings([], expected);
    expect(result.expectedMappingCount).toBe(12);
    expect(result.missedExpectedMappingCount).toBe(12);
    expect(result.precision).toBeNull();
    expect(result.recall).toBe(0);
  });
});
