import {
  SEMANTIC_MAPPING_PROMPT_VERSION,
  SEMANTIC_MAPPING_REQUEST_VERSION,
  SemanticMappingModelInputSchema,
  SemanticMappingModelOutputSchema,
  type DatasetProfile,
  type SemanticMappingModelInput,
  type SemanticMappingModelOutput,
} from "@samewise/contracts";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import { SEMANTIC_MAPPING_DEVELOPER_PROMPT } from "./semantic-mapping-prompt.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5-mini";
export const DEFAULT_SEMANTIC_MAPPING_TIMEOUT_MS = 30_000;

export interface SemanticMapperResult {
  provider: "openai";
  model: string;
  responseId: string;
  output: unknown;
}

export interface SemanticMapper {
  propose(input: SemanticMappingModelInput): Promise<SemanticMapperResult>;
}

export class SemanticMapperError extends Error {
  constructor(public readonly category: "missing_key" | "provider" | "timeout" | "invalid_output", message: string) {
    super(message);
  }
}

export function buildMetadataFirstInput(a: DatasetProfile, b: DatasetProfile): SemanticMappingModelInput {
  return SemanticMappingModelInputSchema.parse({
    requestVersion: SEMANTIC_MAPPING_REQUEST_VERSION,
    datasets: {
      A: { columns: a.columns.map(({ name, inferredType, nullRate, distinctRate, normalizedDistinctRate, mostCommonValueRate, patternShape }) => ({ name, inferredType, nullRate, distinctRate, ...(normalizedDistinctRate == null ? {} : { normalizedDistinctRate }), ...(mostCommonValueRate == null ? {} : { mostCommonValueRate }), ...(patternShape == null ? {} : { patternShape }) })) },
      B: { columns: b.columns.map(({ name, inferredType, nullRate, distinctRate, normalizedDistinctRate, mostCommonValueRate, patternShape }) => ({ name, inferredType, nullRate, distinctRate, ...(normalizedDistinctRate == null ? {} : { normalizedDistinctRate }), ...(mostCommonValueRate == null ? {} : { mostCommonValueRate }), ...(patternShape == null ? {} : { patternShape }) })) },
    },
  });
}

export function validateModelOutput(raw: unknown, input: SemanticMappingModelInput): SemanticMappingModelOutput {
  const parsed = SemanticMappingModelOutputSchema.safeParse(raw);
  if (!parsed.success) throw new SemanticMapperError("invalid_output", "The model output did not match the required schema.");
  const output = parsed.data;
  if (output.mappings.length === 0) throw new SemanticMapperError("invalid_output", "The model returned no useful mappings.");

  const leftColumns = new Set(input.datasets.A.columns.map((column) => column.name));
  const rightColumns = new Set(input.datasets.B.columns.map((column) => column.name));
  const pairs = new Set<string>();
  const mappedLeft = new Set<string>();
  const mappedRight = new Set<string>();
  for (const mapping of output.mappings) {
    if (!leftColumns.has(mapping.leftColumn) || !rightColumns.has(mapping.rightColumn)) {
      throw new SemanticMapperError("invalid_output", "The model referenced a column that does not exist.");
    }
    const pair = `${mapping.leftColumn}\0${mapping.rightColumn}`;
    if (pairs.has(pair)) throw new SemanticMapperError("invalid_output", "The model returned a duplicate mapping.");
    if (mapping.sourceSpecific && (mapping.useForMatching || mapping.includeInMerge)) {
      throw new SemanticMapperError("invalid_output", "A source-specific mapping cannot be recommended for matching or merged output.");
    }
    pairs.add(pair);
    mappedLeft.add(mapping.leftColumn);
    mappedRight.add(mapping.rightColumn);
  }

  const validateUnmapped = (values: string[], allowed: Set<string>, mapped: Set<string>, side: string) => {
    const unique = new Set(values);
    if (unique.size !== values.length || values.some((column) => !allowed.has(column) || mapped.has(column))) {
      throw new SemanticMapperError("invalid_output", `The model returned inconsistent unmapped ${side} columns.`);
    }
  };
  validateUnmapped(output.unmappedLeft, leftColumns, mappedLeft, "left");
  validateUnmapped(output.unmappedRight, rightColumns, mappedRight, "right");
  return output;
}

class OpenAISemanticMapper implements SemanticMapper {
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new OpenAI({ apiKey, timeout: DEFAULT_SEMANTIC_MAPPING_TIMEOUT_MS, maxRetries: 0 });
  }

  async propose(input: SemanticMappingModelInput): Promise<SemanticMapperResult> {
    try {
      const response = await this.client.responses.parse({
        model: this.model,
        store: false,
        input: [
          { role: "developer", content: SEMANTIC_MAPPING_DEVELOPER_PROMPT },
          { role: "user", content: JSON.stringify(input) },
        ],
        text: { format: zodTextFormat(SemanticMappingModelOutputSchema, `samewise_${SEMANTIC_MAPPING_PROMPT_VERSION}`) },
      });
      if (!response.output_parsed) throw new SemanticMapperError("invalid_output", "OpenAI returned no structured proposal.");
      return { provider: "openai", model: this.model, responseId: response.id, output: response.output_parsed };
    } catch (error) {
      if (error instanceof SemanticMapperError) throw error;
      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new SemanticMapperError("timeout", "OpenAI did not respond before the timeout.");
      }
      throw new SemanticMapperError("provider", "OpenAI could not provide mapping suggestions.");
    }
  }
}

export function createSemanticMapperFromEnvironment(environment: NodeJS.ProcessEnv = process.env): SemanticMapper {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  const model = environment.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  if (!apiKey) {
    return {
      async propose() {
        throw new SemanticMapperError("missing_key", "OpenAI is not configured.");
      },
    };
  }
  return new OpenAISemanticMapper(apiKey, model);
}
