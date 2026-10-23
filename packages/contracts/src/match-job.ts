import { z } from "zod";

export const MATCH_JOB_CONTRACT_VERSION = "match-job-v1";

export const MatchJobSchema = z.object({
  contractVersion: z.literal(MATCH_JOB_CONTRACT_VERSION),
  runId: z.string().regex(/^run-[0-9a-f-]+$/i),
  jobId: z.string().regex(/^match-job-[0-9a-f-]+$/i),
  idempotencyKeyHash: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(["queued", "running", "succeeded", "failed"]),
  attempts: z.number().int().min(0).max(3),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  failureCode: z.enum(["matcher_failed", "matcher_timed_out", "worker_interrupted", "retry_exhausted"]).nullable(),
}).strict();

export type MatchJob = z.infer<typeof MatchJobSchema>;
