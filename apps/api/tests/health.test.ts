import { HealthResponseSchema } from "@samewise/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("GET /api/health", () => {
  it("succeeds without binding a TCP port", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);
  });

  it("returns the shared runtime contract", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });
    const parsed = HealthResponseSchema.parse(response.json());

    expect(parsed).toEqual({
      service: "api",
      status: "ok",
      contractVersion: "1.0.0",
    });
  });
});
