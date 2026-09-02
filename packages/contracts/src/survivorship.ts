import { z } from "zod";

export const SURVIVORSHIP_CONTRACT_VERSION = "1.0.0" as const;
export const SURVIVORSHIP_POLICY_SCHEMA_VERSION = "survivorship-policy-v1" as const;
export const TRUSTED_EXPORT_VERSION = "trusted-merged-export-v1" as const;

export const SurvivorshipStrategySchema = z.enum([
  "use_a",
  "use_b",
  "keep_both",
  "prefer_non_null",
  "prefer_newest",
  "prefer_trusted_source",
]);
export type SurvivorshipStrategy = z.infer<typeof SurvivorshipStrategySchema>;

export const RuleStrategySchema = z.enum([
  "keep_both",
  "prefer_non_null",
  "prefer_newest",
  "prefer_trusted_source",
]);
export type RuleStrategy = z.infer<typeof RuleStrategySchema>;

export const FieldPolicyInputSchema = z.object({
  semanticField: z.string().min(1),
  strategy: RuleStrategySchema,
  trustedSource: z.enum(["A", "B"]).optional(),
  timestampMappingId: z.string().min(1).optional(),
}).strict();
export type FieldPolicyInput = z.infer<typeof FieldPolicyInputSchema>;

export const SurvivorshipPolicyInputSchema = z.object({
  fieldPolicies: z.array(FieldPolicyInputSchema),
}).strict();
export type SurvivorshipPolicyInput = z.infer<typeof SurvivorshipPolicyInputSchema>;

export const FieldPolicySchema = FieldPolicyInputSchema.extend({
  ruleId: z.string().min(1),
}).strict();
export type FieldPolicy = z.infer<typeof FieldPolicySchema>;

export const SurvivorshipPolicySchema = z.object({
  contractVersion: z.literal(SURVIVORSHIP_CONTRACT_VERSION),
  schemaVersion: z.literal(SURVIVORSHIP_POLICY_SCHEMA_VERSION),
  policyVersion: z.string().min(1),
  fieldPolicies: z.array(FieldPolicySchema),
  configuredAt: z.string().datetime(),
}).strict();
export type SurvivorshipPolicy = z.infer<typeof SurvivorshipPolicySchema>;

export const ResolutionSnapshotSchema = z.object({
  aValue: z.string(),
  bValue: z.string(),
  aTimestamp: z.string().nullable(),
  bTimestamp: z.string().nullable(),
}).strict();

export const FieldResolutionSchema = z.object({
  resolutionId: z.string().min(1),
  strategy: SurvivorshipStrategySchema,
  resolutionSource: z.enum(["manual", "rule", "keep_both"]),
  chosenSource: z.enum(["A", "B"]).nullable(),
  chosenValue: z.string().nullable(),
  keptValues: z.array(z.object({ source: z.enum(["A", "B"]), value: z.string() }).strict()).max(2),
  reasonCode: z.string().min(1),
  reason: z.string().min(1),
  policyVersion: z.string().min(1).nullable(),
  ruleId: z.string().min(1).nullable(),
  inputSnapshot: ResolutionSnapshotSchema,
  resolvedAt: z.string().datetime(),
}).strict();
export type FieldResolution = z.infer<typeof FieldResolutionSchema>;

export const ResolutionPreviewItemSchema = z.object({
  conflictId: z.string().min(1),
  candidateId: z.string().min(1),
  semanticField: z.string().min(1),
  outcome: z.enum(["would_resolve", "unresolved", "skipped_existing", "skipped_manual"]),
  chosenSource: z.enum(["A", "B"]).nullable(),
  chosenValue: z.string().nullable(),
  keptValues: z.array(z.object({ source: z.enum(["A", "B"]), value: z.string() }).strict()).max(2),
  aTimestamp: z.string().nullable(),
  bTimestamp: z.string().nullable(),
  reasonCode: z.string().min(1),
  reason: z.string().min(1),
}).strict();
export type ResolutionPreviewItem = z.infer<typeof ResolutionPreviewItemSchema>;

export const ResolutionPreviewSchema = z.object({
  contractVersion: z.literal(SURVIVORSHIP_CONTRACT_VERSION),
  runId: z.string().min(1),
  policyVersion: z.string().min(1),
  ruleId: z.string().min(1),
  semanticField: z.string().min(1),
  strategy: RuleStrategySchema,
  affectedCount: z.number().int().nonnegative(),
  resolvableCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
  skippedManualCount: z.number().int().nonnegative(),
  items: z.array(ResolutionPreviewItemSchema),
}).strict();
export type ResolutionPreview = z.infer<typeof ResolutionPreviewSchema>;

export const TrustedExportReadinessSchema = z.object({
  ready: z.boolean(),
  unresolvedIdentityCount: z.number().int().nonnegative(),
  unresolvedConflictCount: z.number().int().nonnegative(),
  eligibleConfirmedCount: z.number().int().nonnegative(),
  onlyACount: z.number().int().nonnegative(),
  onlyBCount: z.number().int().nonnegative(),
  blockers: z.array(z.string().min(1)),
}).strict();
export type TrustedExportReadiness = z.infer<typeof TrustedExportReadinessSchema>;
