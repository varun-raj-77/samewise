import { z } from "zod";

export const COLLISION_EVALUATION_VERSION = "collision-evaluation-v1" as const;

const SourceIdentitySchema = z.object({
  rowId: z.string().min(1),
  entityId: z.string().min(1),
}).strict();

const CandidateEdgeSchema = z.object({
  candidateId: z.string().min(1),
  aRowId: z.string().min(1),
  bRowId: z.string().min(1),
  band: z.enum(["auto_match", "needs_review"]),
  rank: z.number().int().positive(),
  collision: z.boolean(),
}).strict();

export const CollisionScenarioCatalogSchema = z.object({
  fixtureVersion: z.literal(COLLISION_EVALUATION_VERSION),
  origin: z.literal("independently_hand_authored_synthetic_candidate_graphs"),
  note: z.string().min(1),
  cases: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]+$/),
    description: z.string().min(1),
    sourceA: z.array(SourceIdentitySchema).min(1).max(100),
    sourceB: z.array(SourceIdentitySchema).min(1).max(100),
    candidates: z.array(CandidateEdgeSchema).max(1000),
  }).strict()).min(1).max(100),
}).strict();

export type CollisionScenarioCatalog = z.infer<typeof CollisionScenarioCatalogSchema>;
