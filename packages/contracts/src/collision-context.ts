import { z } from "zod";

import { CandidateSummarySchema, PaginationSchema, WORKFLOW_PROJECTION_CONTRACT_VERSION } from "./workflow.js";

/** Read-only, bounded view of every retained candidate referring to a B row. */
export const CollisionContenderSchema = z.object({
  aRowId: z.string().min(1),
  aIdentity: z.record(z.string(), z.string()),
  candidate: CandidateSummarySchema,
  identityStatus: z.enum(["linked_here", "linked_elsewhere", "rejected_pair", "unresolved"]),
  linkSource: z.enum(["human", "matcher"]).nullable(),
  linkedElsewhereBRowId: z.string().min(1).nullable(),
}).strict();

export const CollisionContextPageSchema = z.object({
  contractVersion: z.literal(WORKFLOW_PROJECTION_CONTRACT_VERSION),
  runId: z.string().min(1),
  bRowId: z.string().min(1),
  bIdentity: z.record(z.string(), z.string()),
  distinctARowCount: z.number().int().positive(),
  claimedByARowId: z.string().min(1).nullable(),
  items: z.array(CollisionContenderSchema).max(50),
  page: PaginationSchema,
  ordering: z.literal("rank_score_a_id"),
  note: z.literal("Retained alternatives are not confirmed identities. Inspect each candidate before making any identity decision."),
}).strict();
export type CollisionContextPage = z.infer<typeof CollisionContextPageSchema>;
