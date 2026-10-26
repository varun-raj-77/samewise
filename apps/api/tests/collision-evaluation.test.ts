import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { evaluateCollisionCatalog, CollisionScenarioCatalogSchema } from "../src/collision-evaluation.js";
import { ASSIGNMENT_POLICY_VERSION } from "@samewise/contracts";
import { automaticCandidatesForPolicy } from "../src/identity-selection.js";

const path = resolve(dirname(fileURLToPath(import.meta.url)),
  "../../../evaluation/fixtures/sw-024/independent-collision-cases-v1.json");

async function actual() {
  return CollisionScenarioCatalogSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
describe("SW-024 independently constructed collision cases", () => {
  it("validates all deliberately distinct labeled cases, and enforces a fixed one-to-one policy", async () => {
    const catalog = await actual();
    expect(catalog.cases).toHaveLength(12);
    const result = evaluateCollisionCatalog(catalog);
    expect(result.policyVersion).toBe(ASSIGNMENT_POLICY_VERSION);
    expect(result.scenarioCount).toBe(12);
    expect(result.aggregate.conservative.duplicateBClaims).toBe(0);
    expect(result.cases.every((item) => item.conservative.duplicateBClaims === 0)).toBe(true);
    expect(result.cases.every((item) => item.conservative.falseAutoPairs <= item.legacy.falseAutoPairs)).toBe(true);
    expect(result.aggregate.retainedCandidatePairRecall).toBeGreaterThan(0);
    expect(result.aggregate.retainedCandidatePairRecall).toBeLessThanOrEqual(1);
  });

  it("identifies the cost of false-negative abstention when a weak alternative claims a correct B", async () => {
    const result = evaluateCollisionCatalog(await actual());
    const harmless = result.cases.find((item) => item.id === "harmless_secondary_alternative")!;
    expect(harmless.legacy).toMatchObject({ trueAutoPairs: 2, falseAutoPairs: 0 });
    expect(harmless.conservative).toMatchObject({ trueAutoPairs: 1, falseAutoPairs: 0, duplicateBClaims: 0 });
    expect(harmless.outcomes.correctAutomaticLinksDeferred).toBe(1);
    const cycle = result.cases.find((item) => item.id === "reciprocal_ambiguous_cycle")!;
    expect(cycle.conservative.trueAutoPairs).toBe(0);
    expect(cycle.legacy.trueAutoPairs).toBe(2);
  });

  it("flags duplicate claims and incorrect automatic identities without claiming uniqueness solves scoring", async () => {
    const result = evaluateCollisionCatalog(await actual());
    const dangerous = result.cases.find((item) => item.id === "competing_auto_one_false")!;
    expect(dangerous.legacy.duplicateBClaims).toBe(1);
    expect(dangerous.legacy.falseAutoPairs).toBe(1);
    expect(dangerous.conservative.autoAssignedPairs).toBe(0);
    const uniqueWrong = result.cases.find((item) => item.id === "uncontested_but_wrong")!;
    expect(uniqueWrong.legacy.falseAutoPairs).toBe(1);
    expect(uniqueWrong.conservative.falseAutoPairs).toBe(1);
    expect(uniqueWrong.conservative.duplicateBClaims).toBe(0);
  });

  it("preserves legitimate many-to-one ground truth even though the product assignment mode is one-to-one", async () => {
    const result = evaluateCollisionCatalog(await actual());
    const duplicateTruth = result.cases.find((item) => item.id === "duplicate_canonical_identity")!;
    expect(duplicateTruth.denominators.truthCrossSourcePairs).toBe(2);
    expect(duplicateTruth.denominators.retainedTruePairs).toBe(2);
    expect(duplicateTruth.legacy.trueAutoPairs).toBe(2);
    expect(duplicateTruth.conservative.autoAssignedPairs).toBe(0);
  });

  it("refuses unsupported policy versions and corrupt or duplicate labeled graph definitions", async () => {
    const catalog = await actual();
    expect(() => automaticCandidatesForPolicy([], "future-implicit-selector"))
      .toThrow(/Unsupported historical/);
    const duplicate = structuredClone(catalog);
    duplicate.cases.push(structuredClone(duplicate.cases[0]!));
    expect(() => evaluateCollisionCatalog(duplicate)).toThrow(/duplicate scenario IDs/);
    const unknown = structuredClone(catalog);
    unknown.cases[0]!.candidates[0]!.bRowId = "B99";
    expect(() => evaluateCollisionCatalog(unknown)).toThrow(/outside the held-out fixture/);
    const illegal = structuredClone(catalog) as unknown as Record<string, unknown>;
    illegal.fixtureVersion = "wrong";
    expect(() => evaluateCollisionCatalog(illegal)).toThrow();
  });
});
