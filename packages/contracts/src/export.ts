import { z } from "zod";

import { LegacyManualMappingSchema, ManualMappingSchema } from "./workflow.js";
import { FieldPolicySchema } from "./survivorship.js";

export const RECONCILIATION_EXPORT_VERSION = "reconciliation-export-v3.0.0" as const;
export const RUN_MANIFEST_VERSION = "run-manifest-v1.0.0" as const;
export const EXPORT_SNAPSHOT_VERSION = "export-snapshot-v1.0.0" as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const ExportArtifactSchema = z.object({
  kind: z.enum(["reconciliation_report", "trusted_merged_output"]),
  version: z.string().min(1),
  filename: z.string().min(1),
  mediaType: z.literal("text/csv; charset=utf-8"),
  sha256: Sha256Schema,
  byteLength: z.number().int().nonnegative(),
}).strict();

export const RunManifestSchema = z.object({
  manifestVersion: z.literal(RUN_MANIFEST_VERSION),
  run: z.object({
    runId: z.string().min(1),
    status: z.enum(["matched", "identity_unresolved", "conflicts_unresolved", "trusted_ready"]),
    stage: z.string().min(1),
    snapshot: z.object({
      descriptorVersion: z.literal(EXPORT_SNAPSHOT_VERSION),
      authoritativeStateSha256: Sha256Schema,
    }).strict(),
    relevantTimestamps: z.object({
      mappingProposalCreatedAt: z.string().datetime().nullable(),
      firstIdentityDecisionAt: z.string().datetime().nullable(),
      lastIdentityDecisionAt: z.string().datetime().nullable(),
      policyConfiguredAt: z.string().datetime().nullable(),
      lastResolutionAt: z.string().datetime().nullable(),
    }).strict(),
  }).strict(),
  sourceDatasets: z.object({
    A: z.object({
      side: z.literal("A"), datasetId: z.string().min(1), originalFilename: z.string().min(1),
      sha256: Sha256Schema, rowCount: z.number().int().nonnegative(), profileSchemaVersion: z.string().min(1),
    }).strict(),
    B: z.object({
      side: z.literal("B"), datasetId: z.string().min(1), originalFilename: z.string().min(1),
      sha256: Sha256Schema, rowCount: z.number().int().nonnegative(), profileSchemaVersion: z.string().min(1),
    }).strict(),
  }).strict(),
  semanticMapping: z.object({
    mappingVersion: z.string().min(1),
    confirmedMappings: z.array(z.union([ManualMappingSchema, LegacyManualMappingSchema])),
    ai: z.object({
      provider: z.string().min(1), model: z.string().min(1), promptVersion: z.string().min(1),
      structuredOutputSchemaVersion: z.string().min(1), requestVersion: z.string().min(1), responseId: z.string().min(1),
      proposalId: z.string().min(1), createdAt: z.string().datetime(),
      suggestionDecisions: z.array(z.object({
        suggestionId: z.string().min(1), status: z.enum(["pending", "accepted", "rejected", "edited"]),
        proposedAColumn: z.string().min(1), proposedBColumn: z.string().min(1),
        finalMappingId: z.string().min(1).nullable(),
      }).strict()),
    }).strict().nullable(),
  }).strict(),
  candidateGeneration: z.object({
    candidateEngineVersion: z.string().min(1),
    blockingNormalizationVersion: z.string().min(1),
    candidateConfigVersion: z.string().min(1).nullable(),
    candidateConfigAvailability: z.literal("retained_in_evidence_plan"),
    evidencePlanVersion: z.string().min(1),
    evidencePlanSha256: Sha256Schema,
    evidencePlan: z.record(z.string(), z.unknown()),
  }).strict(),
  matcher: z.object({
    featurePipelineVersion: z.string().min(1), matcherVersion: z.string().min(1),
    matcherConfigVersion: z.string().min(1), matcherConfig: z.record(z.string(), z.unknown()),
    scoreSemanticsVersion: z.string().min(1),
  }).strict(),
  identity: z.object({
    systemEstablishedLinkCount: z.number().int().nonnegative(),
    humanSameCount: z.number().int().nonnegative(),
    humanDifferentCount: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
    deferredCount: z.number().int().nonnegative(),
    collisionRelatedCount: z.number().int().nonnegative(),
    humanBatchPairCount: z.number().int().nonnegative(),
    reviewSignatureVersion: z.string().min(1),
  }).strict(),
  survivorship: z.object({
    policySchemaVersion: z.string().min(1),
    policyVersion: z.string().min(1).nullable(),
    configuredFieldPolicies: z.array(FieldPolicySchema),
    manualResolutionCount: z.number().int().nonnegative(),
    ruleGeneratedResolutionCount: z.number().int().nonnegative(),
    keepBothCount: z.number().int().nonnegative(),
    unresolvedConflictCount: z.number().int().nonnegative(),
  }).strict(),
  evaluation: z.object({
    applicable: z.literal(false), snapshotId: z.null(), snapshotVersion: z.null(),
    reason: z.literal("No versioned evaluation snapshot is attached to this ordinary product run."),
  }).strict(),
  export: z.object({
    artifacts: z.array(ExportArtifactSchema).min(1).max(2),
  }).strict(),
}).strict();

export type ExportArtifact = z.infer<typeof ExportArtifactSchema>;
export type RunManifest = z.infer<typeof RunManifestSchema>;
