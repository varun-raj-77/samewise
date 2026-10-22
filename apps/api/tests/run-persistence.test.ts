import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MATCHER_VERSION,
  ConflictPageSchema,
  RunManifestSchema,
  RunSummarySchema,
  type MatcherResult,
} from "@samewise/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { MatcherRunner } from "../src/matcher-process.js";

const aBytes = Buffer.from("id,name,status\nA1,Acme Corp,active\n");
const bBytes = Buffer.from("id,organization,status\nB1,Acme Corporation,inactive\n");

function matcherResult(): MatcherResult {
  return {
    contractVersion: "1.0.0",
    matcherVersion: MATCHER_VERSION,
    candidateEngineVersion: "candidate-engine-v0.4.0",
    blockingNormalizationVersion: "blocking-normalization-v0.1.0",
    featurePipelineVersion: "feature-pipeline-v0.2.0",
    matcherConfigVersion: "matcher-config-v0.3.0",
    matcherConfig: { frozen: true },
    candidates: [{
      candidateId: "candidate-1-1",
      aRowId: "A1",
      bRowId: "B1",
      aRecord: { id: "A1", name: "Acme Corp", status: "active" },
      bRecord: { id: "B1", organization: "Acme Corporation", status: "inactive" },
      rank: 1,
      matchScore: 0.72,
      runnerUpMargin: 0.2,
      band: "needs_review",
      collision: false,
      strongContradiction: false,
      blockingEvidence: [{ blockerId: "name_token_v1", keyHash: "0123456789abcdef" }],
      positiveEvidence: 0.72,
      conflictEvidence: 0,
      totalWeight: 2,
      evidence: [{
        mappingId: "name",
        label: "Organization name",
        aColumn: "name",
        bColumn: "organization",
        aValue: "Acme Corp",
        bValue: "Acme Corporation",
        normalizedA: "acme",
        normalizedB: "acme",
        fieldKind: "name_or_title",
        featurePipelineVersion: "feature-pipeline-v0.2.0",
        features: [{ name: "token_similarity", value: 1 }],
        outcome: "similar",
        evidenceClass: "partial_agreement",
        weight: 2,
        positiveContribution: 0.72,
        conflictContribution: 0,
        contribution: 0.72,
        explanationCode: "name_partial",
        explanation: "Organization name has partial normalized agreement.",
      }],
    }],
    onlyA: [],
    onlyB: [{ rowId: "B1", record: { id: "B1", organization: "Acme Corporation", status: "inactive" } }],
  };
}

describe("SW-015A durable run repository", () => {
  const apps: ReturnType<typeof buildApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("recovers sources, human decisions, preview tokens, and deterministic exports after restart", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "samewise-durable-"));
    let matchCalls = 0;
    const matcher: MatcherRunner = {
      async profile(input) {
        const columns = input.side === "A" ? ["id", "name", "status"] : ["id", "organization", "status"];
        return {
          contractVersion: "1.0.0",
          datasetId: input.datasetId,
          side: input.side,
          originalFilename: input.originalFilename,
          sha256: input.sha256,
          rowCount: 1,
          columns: columns.map((name) => ({
            name,
            inferredType: "string" as const,
            nullCount: 0,
            nullRate: 0,
            distinctCount: 1,
            distinctRate: 1,
            samples: [name],
          })),
        };
      },
      async match() {
        matchCalls += 1;
        return matcherResult();
      },
    };

    const first = buildApp({ dataRoot, matcher });
    apps.push(first);
    const created = RunSummarySchema.parse((await first.inject({ method: "POST", url: "/api/runs" })).json());
    for (const [side, bytes] of [["A", aBytes], ["B", bBytes]] as const) {
      expect((await first.inject({
        method: "POST",
        url: `/api/runs/${created.runId}/datasets/${side}`,
        headers: { "content-type": "text/csv", "x-file-name": `${side}.csv` },
        payload: bytes,
      })).statusCode).toBe(201);
    }
    expect((await first.inject({
      method: "PUT",
      url: `/api/runs/${created.runId}/mappings`,
      payload: { mappings: [
        { mappingId: "name", label: "Organization name", aColumn: "name", bColumn: "organization", useForMatching: true, includeInMerge: false, normalizer: "text" },
        { mappingId: "status", label: "Status", aColumn: "status", bColumn: "status", useForMatching: false, includeInMerge: true, normalizer: "text" },
      ] },
    })).statusCode).toBe(200);
    expect((await first.inject({ method: "POST", url: `/api/runs/${created.runId}/match` })).statusCode).toBe(200);
    expect((await first.inject({
      method: "POST",
      url: `/api/runs/${created.runId}/candidates/candidate-1-1/decisions`,
      payload: { decision: "same_entity" },
    })).statusCode).toBe(200);

    const fieldPolicies = [{ semanticField: "status", strategy: "keep_both" }];
    const preview = (await first.inject({
      method: "POST",
      url: `/api/runs/${created.runId}/merge-plan-preview`,
      payload: { fieldPolicies },
    })).json();
    expect(preview).toMatchObject({ configuredFields: 1, totalDifferences: 1, willHandle: 1, willRemain: 0 });
    const reconciliationBefore = (await first.inject({ method: "GET", url: `/api/runs/${created.runId}/export` })).body;
    expect(matchCalls).toBe(1);

    await first.close();
    apps.splice(apps.indexOf(first), 1);
    await rm(join(dataRoot, created.runId), { recursive: true, force: true });

    const second = buildApp({ dataRoot, matcher });
    apps.push(second);
    const recovered = RunSummarySchema.parse((await second.inject({ method: "GET", url: `/api/runs/${created.runId}` })).json());
    expect(recovered.summary).toEqual({ matched: 1, needsReview: 0, onlyA: 0, onlyB: 0 });
    expect(matchCalls).toBe(1);
    expect((await second.inject({ method: "GET", url: `/api/runs/${created.runId}/export` })).body).toBe(reconciliationBefore);

    const rematerialized = (await readdir(join(dataRoot, created.runId))).filter((name) => name.endsWith(".csv"));
    expect(rematerialized).toHaveLength(2);

    const conflicts = ConflictPageSchema.parse((await second.inject({
      method: "GET",
      url: `/api/runs/${created.runId}/conflicts?limit=100`,
    })).json());
    expect(conflicts.items).toHaveLength(1);
    expect(conflicts.items[0]?.resolution).toBeNull();

    const applied = await second.inject({
      method: "POST",
      url: `/api/runs/${created.runId}/merge-plan-apply`,
      payload: { fieldPolicies, previewToken: preview.previewToken },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().appliedCount).toBe(1);

    const trustedBeforeSecondRestart = await second.inject({ method: "GET", url: `/api/runs/${created.runId}/trusted-export` });
    expect(trustedBeforeSecondRestart.statusCode).toBe(200);
    const manifestBeforeSecondRestart = RunManifestSchema.parse((await second.inject({
      method: "GET",
      url: `/api/runs/${created.runId}/manifest`,
    })).json());

    await second.close();
    apps.splice(apps.indexOf(second), 1);
    await rm(join(dataRoot, created.runId), { recursive: true, force: true });

    const third = buildApp({ dataRoot, matcher });
    apps.push(third);
    const trustedAfterSecondRestart = await third.inject({ method: "GET", url: `/api/runs/${created.runId}/trusted-export` });
    expect(trustedAfterSecondRestart.statusCode).toBe(200);
    expect(trustedAfterSecondRestart.body).toBe(trustedBeforeSecondRestart.body);
    const manifestAfterSecondRestart = RunManifestSchema.parse((await third.inject({
      method: "GET",
      url: `/api/runs/${created.runId}/manifest`,
    })).json());
    expect(manifestAfterSecondRestart.run.snapshot.authoritativeStateSha256)
      .toBe(manifestBeforeSecondRestart.run.snapshot.authoritativeStateSha256);
    expect(manifestAfterSecondRestart.export.artifacts)
      .toEqual(manifestBeforeSecondRestart.export.artifacts);
    expect(matchCalls).toBe(1);
  });
});
