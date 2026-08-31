import { z } from "zod";

export const HEALTH_RESPONSE_CONTRACT_VERSION = "1.0.0" as const;

export const HealthResponseSchema = z
  .object({
    service: z.string().min(1),
    status: z.literal("ok"),
    contractVersion: z.literal(HEALTH_RESPONSE_CONTRACT_VERSION),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export function createHealthResponse(service: string): HealthResponse {
  return HealthResponseSchema.parse({
    service,
    status: "ok",
    contractVersion: HEALTH_RESPONSE_CONTRACT_VERSION,
  });
}
