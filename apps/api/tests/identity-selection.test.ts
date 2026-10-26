import type { CandidatePair } from "@samewise/contracts";
import { describe, expect, it } from "vitest";

import {
  experimentalPropagatedAutomaticIdentityCandidateIds,
  conservativeAutomaticIdentityCandidateIds,
} from "../src/identity-selection.js";

function pair(
  aRowId: string,
  bRowId: string,
  options: { band?: "auto_match" | "needs_review"; rank?: number; collision?: boolean } = {},
): CandidatePair {
  return {
    candidateId: `${aRowId}:${bRowId}`,
    aRowId, bRowId, band: options.band ?? "auto_match",
    rank: options.rank ?? 1, collision: options.collision ?? false,
  } as CandidatePair;
}

describe("SW-023 safe one-to-one automatic recovery", () => {
  it("recovers an auto pair when its only competitor is anchored to a different unique B", () => {
    const pairs = [
      pair("A1", "B1"),
      pair("A2", "B2"),
      pair("A2", "B1", { band: "needs_review", rank: 2 }),
    ];
    expect([...conservativeAutomaticIdentityCandidateIds(pairs)]).toEqual(["A2:B2"]);
    expect([...experimentalPropagatedAutomaticIdentityCandidateIds(pairs)].sort()).toEqual(["A1:B1", "A2:B2"]);
    expect([...experimentalPropagatedAutomaticIdentityCandidateIds([...pairs].reverse())].sort()).toEqual(["A1:B1", "A2:B2"]);
  });

  it("does not choose a winner between two competing automatic claims for the same B", () => {
    const pairs = [pair("A1", "B1"), pair("A2", "B1")];
    expect([...experimentalPropagatedAutomaticIdentityCandidateIds(pairs)]).toEqual([]);
  });

  it("does not force a winner in a reciprocal cycle or unanchored alternative", () => {
    const cycle = [
      pair("A1", "B1"), pair("A2", "B2"),
      pair("A1", "B2", { band: "needs_review", rank: 2 }),
      pair("A2", "B1", { band: "needs_review", rank: 2 }),
    ];
    expect([...experimentalPropagatedAutomaticIdentityCandidateIds(cycle)]).toEqual([]);
    expect([...experimentalPropagatedAutomaticIdentityCandidateIds([pair("A1", "B1"), pair("A2", "B1", {
      band: "needs_review", rank: 1,
    })])]).toEqual([]);
  });

  it("propagates through a three-link chain with unique A and B ownership", () => {
    const pairs = [
      pair("A1", "B1"),
      pair("A2", "B2"), pair("A2", "B1", { band: "needs_review", rank: 2 }),
      pair("A3", "B3"), pair("A3", "B2", { band: "needs_review", rank: 2 }),
    ];
    expect([...experimentalPropagatedAutomaticIdentityCandidateIds(pairs)].sort()).toEqual(["A1:B1", "A2:B2", "A3:B3"]);
  });

  it("retains collision hints and duplicate rank-1 proposals as fail-closed gates", () => {
    const collisions = [pair("A1", "B1", { collision: true }), pair("A2", "B2")];
    expect([...experimentalPropagatedAutomaticIdentityCandidateIds(collisions)]).toEqual(["A2:B2"]);
    const badRank = [pair("A1", "B1"), pair("A1", "B2")];
    expect([...experimentalPropagatedAutomaticIdentityCandidateIds(badRank)]).toEqual([]);
  });

  it("does not recover a dependent link after a human rejects its supporting anchor", () => {
    const pairs = [
      pair("A1", "B1"),
      pair("A2", "B2"),
      pair("A2", "B1", { band: "needs_review", rank: 2 }),
    ];
    expect([...experimentalPropagatedAutomaticIdentityCandidateIds(pairs, {
      excludedCandidateIds: new Set(["A2:B2"]),
    })]).toEqual([]);
    expect([...experimentalPropagatedAutomaticIdentityCandidateIds(pairs, {
      reservedBRowIds: new Set(["B2"]),
    })]).toEqual([]);
    expect([...experimentalPropagatedAutomaticIdentityCandidateIds(pairs, {
      reservedARowIds: new Set(["A2"]),
    })]).toEqual([]);
  });

  it("never reuses a B across a long contested chain and avoids input-order dependence", () => {
    const pairs: CandidatePair[] = [];
    for (let i = 0; i < 100; i += 1) {
      pairs.push(pair(`A${i}`, `B${i}`));
      if (i) pairs.push(pair(`A${i}`, `B${i - 1}`, { band: "needs_review", rank: 2 }));
    }
    const a = experimentalPropagatedAutomaticIdentityCandidateIds(pairs);
    const b = experimentalPropagatedAutomaticIdentityCandidateIds([...pairs].reverse());
    expect(a.size).toBe(100);
    expect([...a].sort()).toEqual([...b].sort());
    const byId = new Map(pairs.map((candidate) => [candidate.candidateId, candidate]));
    expect(new Set([...a].map((id) => byId.get(id)!.bRowId)).size).toBe(a.size);
  });
});
