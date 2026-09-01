import { z } from "zod";

import { ManualMappingSchema } from "./workflow.js";

export const SEMANTIC_MAPPING_CONTRACT_VERSION = "1.0.0" as const;
export const SEMANTIC_MAPPING_PROMPT_VERSION = "semantic-mapping-prompt-v1" as const;
export const SEMANTIC_MAPPING_REQUEST_VERSION = "metadata-first-v1" as const;

export const SemanticRelationSchema = z.enum([
  "equivalent",
  "related_but_not_equivalent",
  "derived",
  "unknown",
]);

export const NormalizationHintSchema = z.enum([
  "casefold",
  "trim_whitespace",
  "phone_digits",
  "corporate_suffix_normalization",
  "punctuation_normalization",
]);

export const ModelColumnProfileSchema = z.object({
  name: z.string().min(1),
  inferredType: z.enum(["string", "integer", "number", "boolean", "date", "unknown"]),
  nullRate: z.number().finite().min(0).max(1),
  distinctRate: z.number().finite().min(0).max(1),
}).strict();

export const SemanticMappingModelInputSchema = z.object({
  requestVersion: z.literal(SEMANTIC_MAPPING_REQUEST_VERSION),
  datasets: z.object({
    A: z.object({ columns: z.array(ModelColumnProfileSchema).min(1) }).strict(),
    B: z.object({ columns: z.array(ModelColumnProfileSchema).min(1) }).strict(),
  }).strict(),
}).strict();
export type SemanticMappingModelInput = z.infer<typeof SemanticMappingModelInputSchema>;

export const SemanticMappingModelSuggestionSchema = z.object({
  leftColumn: z.string().min(1),
  rightColumn: z.string().min(1),
  relation: SemanticRelationSchema,
  role: z.enum(["identity", "comparison"]),
  confidence: z.number().finite().min(0).max(1),
  reason: z.string().min(1).max(300),
  normalizationHints: z.array(NormalizationHintSchema).max(5),
}).strict();

export const SemanticMappingModelOutputSchema = z.object({
  mappings: z.array(SemanticMappingModelSuggestionSchema).max(200),
  unmappedLeft: z.array(z.string().min(1)).max(200),
  unmappedRight: z.array(z.string().min(1)).max(200),
}).strict();
export type SemanticMappingModelOutput = z.infer<typeof SemanticMappingModelOutputSchema>;

export const ModelProvenanceSchema = z.object({
  provider: z.literal("openai"),
  model: z.string().min(1),
  promptVersion: z.literal(SEMANTIC_MAPPING_PROMPT_VERSION),
  schemaVersion: z.literal(SEMANTIC_MAPPING_CONTRACT_VERSION),
  requestVersion: z.literal(SEMANTIC_MAPPING_REQUEST_VERSION),
  responseId: z.string().min(1),
}).strict();

export const MappingSuggestionStatusSchema = z.enum(["pending", "accepted", "rejected", "edited"]);
export const SemanticMappingSuggestionSchema = SemanticMappingModelSuggestionSchema.extend({
  suggestionId: z.string().min(1),
  status: MappingSuggestionStatusSchema,
  finalMapping: ManualMappingSchema.nullable(),
}).strict();

export const SemanticMappingProposalSchema = z.object({
  contractVersion: z.literal(SEMANTIC_MAPPING_CONTRACT_VERSION),
  proposalId: z.string().min(1),
  runId: z.string().min(1),
  provenance: ModelProvenanceSchema,
  suggestions: z.array(SemanticMappingSuggestionSchema).min(1),
  unmappedLeft: z.array(z.string().min(1)),
  unmappedRight: z.array(z.string().min(1)),
  createdAt: z.string().datetime(),
}).strict();
export type SemanticMappingProposal = z.infer<typeof SemanticMappingProposalSchema>;

export const MappingSuggestionDecisionSchema = z.object({
  decision: z.enum(["accept", "reject", "remap"]),
  finalMapping: ManualMappingSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.decision === "remap" && !value.finalMapping) {
    context.addIssue({ code: "custom", message: "A remapped final mapping is required.", path: ["finalMapping"] });
  }
  if (value.decision === "reject" && value.finalMapping) {
    context.addIssue({ code: "custom", message: "Rejected suggestions cannot have a final mapping.", path: ["finalMapping"] });
  }
  if (value.decision === "accept" && value.finalMapping) {
    context.addIssue({ code: "custom", message: "Accept uses the original suggestion; use remap to edit it.", path: ["finalMapping"] });
  }
});
export type MappingSuggestionDecision = z.infer<typeof MappingSuggestionDecisionSchema>;

export const MappingSuggestionResponseSchema = z.object({
  contractVersion: z.literal(SEMANTIC_MAPPING_CONTRACT_VERSION),
  proposal: SemanticMappingProposalSchema,
  confirmedMappings: z.array(ManualMappingSchema),
}).strict();
export type MappingSuggestionResponse = z.infer<typeof MappingSuggestionResponseSchema>;
