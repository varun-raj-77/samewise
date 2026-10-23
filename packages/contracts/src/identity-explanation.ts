import { z } from "zod";

import { CANDIDATE_ENGINE_VERSION, MATCHER_VERSION, FEATURE_PIPELINE_VERSION } from "./workflow.js";

// The outcome is about what the *recorded run* linked, not a claim of true identity.
export const IDENTITY_EXPLANATION_VERSION = "identity-explanation-v1" as const;

export const IdentityExplanationSchema = z.object({
  explanationVersion: z.literal(IDENTITY_EXPLANATION_VERSION),
  runId: z.string().min(1),
  aRowId: z.string().min(1),
  bRowId: z.string().nullable(),
  reasonCode: z.enum([
    "linked_automatically",
    "linked_by_human",
    "rejected_by_human",
    "other_candidate_linked",
    "candidate_awaiting_review",
    "alternative_not_selected",
    "no_candidate_retained",
  ]),
  evidenceScope: z.enum(["retained_candidate", "none_retained"]),
  linkedBRowId: z.string().nullable(),
  humanDecision: z.enum(["same_entity", "different_entity"]).nullable(),
  candidateId: z.string().nullable(),
  candidateRank: z.number().int().positive().nullable(),
  candidateCount: z.number().int().nonnegative(),
  matchScore: z.number().min(0).max(1).nullable(),
  matchBand: z.enum(["auto_match", "needs_review"]).nullable(),
  hasCollision: z.boolean(),
  strongContradiction: z.boolean(),
  matcherVersion: z.literal(MATCHER_VERSION),
  candidateEngineVersion: z.literal(CANDIDATE_ENGINE_VERSION),
  retainedEvidenceCount: z.number().int().nonnegative(),
  fieldEvidence: z.array(z.object({
    mappingId: z.string().min(1),
    label: z.string().min(1),
    explanationCode: z.string().min(1),
    explanation: z.string().min(1),
    evidenceClass: z.enum(["exact_agreement", "partial_agreement", "conflict", "missing_left", "missing_right", "missing_both"]),
    positiveContribution: z.number().nonnegative(),
    conflictContribution: z.number().nonnegative(),
    featurePipelineVersion: z.literal(FEATURE_PIPELINE_VERSION),
  }).strict()).max(6),
  blockingRuleIds: z.array(z.string().min(1)).max(6),
}).strict();

export type IdentityExplanation = z.infer<typeof IdentityExplanationSchema>;
