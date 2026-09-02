import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  FieldPolicyInputSchema,
  SURVIVORSHIP_CONTRACT_VERSION,
  SurvivorshipPolicyInputSchema,
} from "../src/index.js";

describe("SW-008 survivorship contract", () => {
  it("keeps the language-neutral version synchronized", async () => {
    const schema = JSON.parse(await readFile(new URL("../schemas/survivorship/1.0.0.json", import.meta.url), "utf8")) as { "x-contract-version": string };
    expect(schema["x-contract-version"]).toBe(SURVIVORSHIP_CONTRACT_VERSION);
  });

  it("accepts only controlled enum rules and rejects executable payloads", () => {
    expect(FieldPolicyInputSchema.parse({ semanticField: "phone", strategy: "prefer_trusted_source", trustedSource: "A" })).toEqual({ semanticField: "phone", strategy: "prefer_trusted_source", trustedSource: "A" });
    expect(FieldPolicyInputSchema.safeParse({ semanticField: "phone", strategy: "javascript", code: "process.exit()" }).success).toBe(false);
    expect(SurvivorshipPolicyInputSchema.safeParse({ fieldPolicies: [{ semanticField: "phone", strategy: "prefer_non_null", code: "return A" }] }).success).toBe(false);
  });
});
