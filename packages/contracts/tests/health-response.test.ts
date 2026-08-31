import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createHealthResponse,
  HEALTH_RESPONSE_CONTRACT_VERSION,
  HealthResponseSchema,
} from "../src/index.js";

const schemaUrl = new URL(
  "../schemas/health-response/1.0.0.json",
  import.meta.url,
);
const examplesUrl = new URL(
  "../examples/health-response/1.0.0.json",
  import.meta.url,
);

interface HealthResponseJsonSchema {
  type: string;
  additionalProperties: boolean;
  required: string[];
  properties: {
    service: { type: string; minLength: number };
    status: { const: string };
    contractVersion: { type: string; const: string };
  };
  "x-contract-version": string;
}

interface ContractExample {
  name: string;
  value: unknown;
}

interface ContractExamples {
  contractVersion: string;
  valid: ContractExample[];
  invalid: ContractExample[];
}

async function loadContractAssets() {
  const [schemaText, examplesText] = await Promise.all([
    readFile(schemaUrl, "utf8"),
    readFile(examplesUrl, "utf8"),
  ]);

  return {
    schema: JSON.parse(schemaText) as HealthResponseJsonSchema,
    examples: JSON.parse(examplesText) as ContractExamples,
  };
}

function conformsToCanonicalSchema(
  candidate: unknown,
  schema: HealthResponseJsonSchema,
): boolean {
  if (
    schema.type !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    typeof candidate !== "object"
  ) {
    return false;
  }

  const value = candidate as Record<string, unknown>;
  const propertyNames = Object.keys(schema.properties);

  if (schema.required.some((name) => !(name in value))) {
    return false;
  }

  if (
    !schema.additionalProperties &&
    Object.keys(value).some((name) => !propertyNames.includes(name))
  ) {
    return false;
  }

  return (
    schema.properties.service.type === "string" &&
    typeof value.service === "string" &&
    value.service.length >= schema.properties.service.minLength &&
    value.status === schema.properties.status.const &&
    schema.properties.contractVersion.type === "string" &&
    typeof value.contractVersion === "string" &&
    value.contractVersion === schema.properties.contractVersion.const
  );
}

describe("HealthResponse contract", () => {
  it("creates and validates a health response", () => {
    expect(createHealthResponse("api")).toEqual({
      service: "api",
      status: "ok",
      contractVersion: "1.0.0",
    });
  });

  it("classifies shared examples according to the canonical schema", async () => {
    const { schema, examples } = await loadContractAssets();

    for (const example of examples.valid) {
      expect(
        conformsToCanonicalSchema(example.value, schema),
        example.name,
      ).toBe(true);
    }

    for (const example of examples.invalid) {
      expect(
        conformsToCanonicalSchema(example.value, schema),
        example.name,
      ).toBe(false);
    }
  });

  it("classifies shared examples equivalently with Zod", async () => {
    const { examples } = await loadContractAssets();

    for (const example of examples.valid) {
      expect(HealthResponseSchema.safeParse(example.value).success, example.name).toBe(
        true,
      );
    }

    for (const example of examples.invalid) {
      expect(HealthResponseSchema.safeParse(example.value).success, example.name).toBe(
        false,
      );
    }
  });

  it("stays synchronized with the canonical JSON Schema", async () => {
    const { schema, examples } = await loadContractAssets();

    expect(schema.required).toEqual([
      "service",
      "status",
      "contractVersion",
    ]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.service).toEqual({ type: "string", minLength: 1 });
    expect(schema.properties.status.const).toBe("ok");
    expect(schema.properties.contractVersion.const).toBe(
      HEALTH_RESPONSE_CONTRACT_VERSION,
    );
    expect(schema["x-contract-version"]).toBe(
      HEALTH_RESPONSE_CONTRACT_VERSION,
    );
    expect(examples.contractVersion).toBe(HEALTH_RESPONSE_CONTRACT_VERSION);
  });
});
