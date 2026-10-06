import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const applications: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
});

describe("GET /health", () => {
  it("reports that the Peragus backend is running", async () => {
    const app = await buildApp();
    applications.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body).toMatchObject({
      status: "ok",
      service: "peragus-backend",
      version: "0.1.0",
    });

    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    expect(body.uptimeSeconds).toEqual(expect.any(Number));
  });
});
