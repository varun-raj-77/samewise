import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MATCHER_VERSION,
  MappingSuggestionResponseSchema,
  RunManifestSchema,
  RunSummarySchema,
  type MatcherResult,
  type SemanticMappingModelOutput,
} from "@samewise/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { MatcherRunner } from "../src/matcher-process.js";
import {
  createSemanticMapperFromEnvironment,
  SemanticMapperError,
  type SemanticMapper,
  type SemanticMapperResult,
} from "../src/semantic-mapper.js";

const aBytes = Buffer.from("id,name,status,private_value\nA1,Acme,active,DO_NOT_FORWARD_ENTIRE_ROW\n");
const bBytes = Buffer.from("id,organization,state,secret\nB1,Acme,active,HIDDEN_CANONICAL_ID\n");

const validOutput: SemanticMappingModelOutput = {
  mappings: [
    { leftColumn: "name", rightColumn: "organization", relation: "equivalent", role: "identity", confidence: 0.94, reason: "Both names indicate an organization field.", normalizationHints: ["casefold"] },
    { leftColumn: "status", rightColumn: "state", relation: "equivalent", role: "comparison", confidence: 0.76, reason: "Both appear to contain business status.", normalizationHints: ["trim_whitespace"] },
  ],
  unmappedLeft: ["id", "private_value"],
  unmappedRight: ["id", "secret"],
};

function mapperWith(output: unknown): SemanticMapper {
  return { async propose(): Promise<SemanticMapperResult> { return { provider: "openai", model: "test-model", responseId: "response-test", output }; } };
}

function matcherWithCapture(capture: (mappings: Parameters<MatcherRunner["match"]>[0]["mappings"]) => void = () => undefined): MatcherRunner {
  return {
    async profile(input) {
      const names = input.side === "A" ? ["id", "name", "status", "private_value"] : ["id", "organization", "state", "secret"];
      return {
        contractVersion: "1.0.0", datasetId: input.datasetId, side: input.side,
        originalFilename: input.originalFilename, sha256: input.sha256, rowCount: 1,
        columns: names.map((name) => ({
          name, inferredType: "string", nullCount: 0, nullRate: 0, distinctCount: 1, distinctRate: 1,
          samples: [name === "private_value" ? "DO_NOT_FORWARD_ENTIRE_ROW" : name === "secret" ? "HIDDEN_CANONICAL_ID" : "sample"],
        })),
      };
    },
    async match(input): Promise<MatcherResult> {
      capture(input.mappings);
      return { contractVersion: "1.0.0", matcherVersion: MATCHER_VERSION, candidateEngineVersion: "candidate-engine-v0.2.0", blockingNormalizationVersion: "blocking-normalization-v0.1.0", featurePipelineVersion: "feature-pipeline-v0.1.0", matcherConfigVersion: "matcher-config-v0.2.0", matcherConfig: { frozen: true }, candidates: [], onlyA: [], onlyB: [] };
    },
  };
}

describe("SW-004 semantic mapping API", () => {
  let dataRoot: string;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => { dataRoot = await mkdtemp(join(tmpdir(), "samewise-semantic-")); });
  afterEach(async () => { if (app) await app.close(); });

  async function setup(semanticMapper: SemanticMapper, matcher = matcherWithCapture()) {
    app = buildApp({ dataRoot, matcher, semanticMapper });
    const created = RunSummarySchema.parse((await app.inject({ method: "POST", url: "/api/runs" })).json());
    for (const [side, bytes] of [["A", aBytes], ["B", bBytes]] as const) {
      const response = await app.inject({ method: "POST", url: `/api/runs/${created.runId}/datasets/${side}`, headers: { "content-type": "text/csv", "x-file-name": `${side}.csv` }, payload: bytes });
      expect(response.statusCode).toBe(201);
    }
    return created.runId;
  }

  async function suggest(runId: string) {
    return app.inject({ method: "POST", url: `/api/runs/${runId}/mapping-suggestions` });
  }

  it("returns a valid pending structured proposal without auto-confirming it", async () => {
    const runId = await setup(mapperWith(validOutput));
    const response = await suggest(runId);
    expect(response.statusCode).toBe(201);
    const payload = MappingSuggestionResponseSchema.parse(response.json());
    expect(payload.proposal.suggestions.every((item) => item.status === "pending" && item.finalMapping === null)).toBe(true);
    expect(payload.proposal.provenance).toMatchObject({ provider: "openai", model: "test-model", responseId: "response-test", promptVersion: "semantic-mapping-prompt-v1", requestVersion: "metadata-first-v1" });
    expect(payload.confirmedMappings).toEqual([]);
    expect((await app.inject({ method: "POST", url: `/api/runs/${runId}/match` })).statusCode).toBe(400);
  });

  it.each([
    ["unknown column", { ...validOutput, mappings: [{ ...validOutput.mappings[0]!, leftColumn: "fabricated" }] }],
    ["invalid confidence", { ...validOutput, mappings: [{ ...validOutput.mappings[0]!, confidence: 1.1 }] }],
    ["duplicate pair", { ...validOutput, mappings: [validOutput.mappings[0]!, validOutput.mappings[0]!] }],
  ])("rejects %s as a safe unavailable proposal", async (_label, output) => {
    const runId = await setup(mapperWith(output));
    const response = await suggest(runId);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: "ai_invalid_output", message: "AI suggestions unavailable. You can continue mapping columns manually." } });
  });

  it("uses only authoritative server-owned metadata and excludes samples, rows, paths, hashes, filenames, and hidden truth markers", async () => {
    let captured: unknown;
    const semanticMapper: SemanticMapper = { async propose(input) { captured = input; return { provider: "openai", model: "test-model", responseId: "response-test", output: validOutput }; } };
    const runId = await setup(semanticMapper);
    await suggest(runId);
    const serialized = JSON.stringify(captured);
    expect(captured).toEqual({ requestVersion: "metadata-first-v1", datasets: {
      A: { columns: ["id", "name", "status", "private_value"].map((name) => ({ name, inferredType: "string", nullRate: 0, distinctRate: 1 })) },
      B: { columns: ["id", "organization", "state", "secret"].map((name) => ({ name, inferredType: "string", nullRate: 0, distinctRate: 1 })) },
    } });
    for (const forbidden of ["DO_NOT_FORWARD_ENTIRE_ROW", "HIDDEN_CANONICAL_ID", ".csv", "sha256", "datasetId", "samples", "canonical", "corruption", "partner"]) expect(serialized).not.toContain(forbidden);
  });

  it("keeps manual mapping and immutable source bytes intact when OpenAI is unavailable", async () => {
    const unavailable: SemanticMapper = { async propose() { throw new SemanticMapperError("provider", "provider detail"); } };
    const runId = await setup(unavailable);
    const manual = { mappingId: "manual-name", label: "Organization", aColumn: "name", bColumn: "organization", role: "identity", normalizer: "text" };
    await app.inject({ method: "PUT", url: `/api/runs/${runId}/mappings`, payload: { mappings: [manual] } });
    const paths = (await readdir(join(dataRoot, runId))).map((name) => join(dataRoot, runId, name));
    const before = await Promise.all(paths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")));
    expect((await suggest(runId)).statusCode).toBe(503);
    const current = RunSummarySchema.parse((await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json());
    expect(current.mappings).toEqual([manual]);
    const after = await Promise.all(paths.map(async (path) => createHash("sha256").update(await readFile(path)).digest("hex")));
    expect(after).toEqual(before);
  });

  it("has a safe missing-key fallback without making a provider call", async () => {
    const runId = await setup(createSemanticMapperFromEnvironment({}));
    const response = await suggest(runId);
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toEqual({ code: "ai_missing_key", message: "AI suggestions unavailable. You can continue mapping columns manually." });
  });

  it("consumes accepted mappings, ignores rejected suggestions, and preserves original proposal when remapped", async () => {
    let consumed: Parameters<MatcherRunner["match"]>[0]["mappings"] = [];
    const runId = await setup(mapperWith(validOutput), matcherWithCapture((mappings) => { consumed = mappings; }));
    const proposal = MappingSuggestionResponseSchema.parse((await suggest(runId)).json()).proposal;
    const [nameSuggestion, statusSuggestion] = proposal.suggestions;
    expect(nameSuggestion && statusSuggestion).toBeTruthy();

    const accepted = await app.inject({ method: "PATCH", url: `/api/runs/${runId}/mapping-suggestions/${nameSuggestion!.suggestionId}`, payload: { decision: "accept" } });
    expect(MappingSuggestionResponseSchema.parse(accepted.json()).proposal.suggestions[0]?.status).toBe("accepted");
    const rejected = await app.inject({ method: "PATCH", url: `/api/runs/${runId}/mapping-suggestions/${statusSuggestion!.suggestionId}`, payload: { decision: "reject" } });
    expect(MappingSuggestionResponseSchema.parse(rejected.json()).confirmedMappings).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/api/runs/${runId}/match` })).statusCode).toBe(200);
    expect(consumed.map((item) => [item.aColumn, item.bColumn])).toEqual([["name", "organization"]]);
    const manifest = RunManifestSchema.parse(JSON.parse((await app.inject({ method: "GET", url: `/api/runs/${runId}/manifest` })).body));
    expect(manifest.semanticMapping.ai).toMatchObject({
      provider: "openai", model: "test-model", promptVersion: "semantic-mapping-prompt-v1",
      structuredOutputSchemaVersion: "1.0.0", requestVersion: "metadata-first-v1",
      suggestionDecisions: expect.arrayContaining([
        expect.objectContaining({ suggestionId: nameSuggestion!.suggestionId, status: "accepted" }),
        expect.objectContaining({ suggestionId: statusSuggestion!.suggestionId, status: "rejected", finalMappingId: null }),
      ]),
    });
    expect(JSON.stringify(manifest)).not.toContain("DO_NOT_FORWARD_ENTIRE_ROW");

    await app.close();
    const remapOutput = { ...validOutput, mappings: [validOutput.mappings[0]!] };
    const remapRunId = await setup(mapperWith(remapOutput));
    const remapProposal = MappingSuggestionResponseSchema.parse((await suggest(remapRunId)).json()).proposal;
    const original = remapProposal.suggestions[0]!;
    const finalMapping = { mappingId: "edited-name", label: "Corrected name", aColumn: "name", bColumn: "state", role: "comparison", normalizer: "text" };
    const remapped = MappingSuggestionResponseSchema.parse((await app.inject({ method: "PATCH", url: `/api/runs/${remapRunId}/mapping-suggestions/${original.suggestionId}`, payload: { decision: "remap", finalMapping } })).json());
    expect(remapped.proposal.suggestions[0]).toMatchObject({ leftColumn: "name", rightColumn: "organization", confidence: 0.94, status: "edited", finalMapping });
  });

  it("does not mutate existing confirmed mappings after malformed or empty provider output", async () => {
    const sequence = vi.fn()
      .mockResolvedValueOnce({ provider: "openai", model: "test-model", responseId: "one", output: validOutput })
      .mockResolvedValueOnce({ provider: "openai", model: "test-model", responseId: "two", output: { mappings: [], unmappedLeft: [], unmappedRight: [] } });
    const runId = await setup({ propose: sequence });
    const proposal = MappingSuggestionResponseSchema.parse((await suggest(runId)).json()).proposal;
    await app.inject({ method: "PATCH", url: `/api/runs/${runId}/mapping-suggestions/${proposal.suggestions[0]!.suggestionId}`, payload: { decision: "accept" } });
    expect((await suggest(runId)).statusCode).toBe(503);
    const current = RunSummarySchema.parse((await app.inject({ method: "GET", url: `/api/runs/${runId}` })).json());
    expect(current.mappings).toHaveLength(1);
  });
});
