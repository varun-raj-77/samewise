import { z } from "zod";

export const WORKFLOW_CONTRACT_VERSION = "1.0.0" as const;
export const MATCHER_VERSION = "baseline-matcher-v0.1.0" as const;

export const DatasetSideSchema = z.enum(["A", "B"]);
export type DatasetSide = z.infer<typeof DatasetSideSchema>;

export const ColumnProfileSchema = z.object({
  name: z.string().min(1),
  inferredType: z.enum(["string", "integer", "number", "boolean", "date", "unknown"]),
  nullCount: z.number().int().nonnegative(),
  nullRate: z.number().min(0).max(1),
  distinctCount: z.number().int().nonnegative(),
  distinctRate: z.number().min(0).max(1),
  samples: z.array(z.string()).max(3),
}).strict();

export const DatasetProfileSchema = z.object({
  contractVersion: z.literal(WORKFLOW_CONTRACT_VERSION),
  datasetId: z.string().min(1),
  side: DatasetSideSchema,
  originalFilename: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  rowCount: z.number().int().nonnegative(),
  columns: z.array(ColumnProfileSchema).min(1),
}).strict();
export type DatasetProfile = z.infer<typeof DatasetProfileSchema>;

export const MappingRoleSchema = z.enum(["identity", "comparison"]);
export const NormalizerSchema = z.enum(["text", "phone", "email", "number", "date"]);
export const ManualMappingSchema = z.object({
  mappingId: z.string().min(1),
  label: z.string().min(1),
  aColumn: z.string().min(1),
  bColumn: z.string().min(1),
  role: MappingRoleSchema,
  normalizer: NormalizerSchema,
}).strict();
export type ManualMapping = z.infer<typeof ManualMappingSchema>;

export const FieldEvidenceSchema = z.object({
  mappingId: z.string().min(1),
  label: z.string().min(1),
  aColumn: z.string().min(1),
  bColumn: z.string().min(1),
  aValue: z.string(),
  bValue: z.string(),
  normalizedA: z.string(),
  normalizedB: z.string(),
  outcome: z.enum(["exact", "similar", "conflict", "missing_one", "missing_both"]),
  contribution: z.number().min(0).max(1),
  explanation: z.string().min(1),
}).strict();
export type FieldEvidence = z.infer<typeof FieldEvidenceSchema>;

export const CandidatePairSchema = z.object({
  candidateId: z.string().min(1),
  aRowId: z.string().min(1),
  bRowId: z.string().min(1),
  aRecord: z.record(z.string(), z.string()),
  bRecord: z.record(z.string(), z.string()),
  rank: z.number().int().positive(),
  baselineScore: z.number().min(0).max(1),
  runnerUpMargin: z.number().min(0).max(1),
  band: z.enum(["proposed_match", "needs_review"]),
  collision: z.boolean(),
  evidence: z.array(FieldEvidenceSchema).min(1),
}).strict();
export type CandidatePair = z.infer<typeof CandidatePairSchema>;

export const MatcherResultSchema = z.object({
  contractVersion: z.literal(WORKFLOW_CONTRACT_VERSION),
  matcherVersion: z.literal(MATCHER_VERSION),
  candidates: z.array(CandidatePairSchema),
  onlyA: z.array(z.object({ rowId: z.string().min(1), record: z.record(z.string(), z.string()) }).strict()),
  onlyB: z.array(z.object({ rowId: z.string().min(1), record: z.record(z.string(), z.string()) }).strict()),
}).strict();
export type MatcherResult = z.infer<typeof MatcherResultSchema>;

export const IdentityDecisionSchema = z.object({
  decisionId: z.string().min(1),
  runId: z.string().min(1),
  candidateId: z.string().min(1),
  aRowId: z.string().min(1),
  bRowId: z.string().min(1),
  systemProposal: z.enum(["proposed_match", "needs_review"]),
  humanDecision: z.enum(["same_entity", "different_entity"]),
  matcherVersion: z.literal(MATCHER_VERSION),
  evidenceShown: z.array(FieldEvidenceSchema).min(1),
  decidedAt: z.string().datetime(),
}).strict();
export type IdentityDecision = z.infer<typeof IdentityDecisionSchema>;

export const FieldResolutionSchema = z.object({
  resolutionId: z.string().min(1),
  chosenSource: DatasetSideSchema,
  chosenValue: z.string(),
  action: z.enum(["use_a", "use_b"]),
  resolvedAt: z.string().datetime(),
}).strict();
export type FieldResolution = z.infer<typeof FieldResolutionSchema>;

export const FieldConflictSchema = z.object({
  conflictId: z.string().min(1),
  runId: z.string().min(1),
  candidateId: z.string().min(1),
  mappingId: z.string().min(1),
  label: z.string().min(1),
  aColumn: z.string().min(1),
  bColumn: z.string().min(1),
  aValue: z.string(),
  bValue: z.string(),
  resolution: FieldResolutionSchema.nullable(),
}).strict();
export type FieldConflict = z.infer<typeof FieldConflictSchema>;

export const ResultSummarySchema = z.object({
  matched: z.number().int().nonnegative(),
  needsReview: z.number().int().nonnegative(),
  onlyA: z.number().int().nonnegative(),
  onlyB: z.number().int().nonnegative(),
}).strict();

export const RunViewSchema = z.object({
  contractVersion: z.literal(WORKFLOW_CONTRACT_VERSION),
  runId: z.string().min(1),
  stage: z.enum(["upload", "profile", "mapping", "results", "review", "resolution", "export"]),
  datasets: z.object({ A: DatasetProfileSchema.optional(), B: DatasetProfileSchema.optional() }).strict(),
  mappings: z.array(ManualMappingSchema),
  matcherVersion: z.literal(MATCHER_VERSION).nullable(),
  summary: ResultSummarySchema.nullable(),
  candidates: z.array(CandidatePairSchema),
  decisions: z.array(IdentityDecisionSchema),
  conflicts: z.array(FieldConflictSchema),
  onlyA: MatcherResultSchema.shape.onlyA,
  onlyB: MatcherResultSchema.shape.onlyB,
}).strict();
export type RunView = z.infer<typeof RunViewSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
}).strict();
