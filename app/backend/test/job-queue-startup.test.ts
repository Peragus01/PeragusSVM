import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { startJobQueue } from "../src/jobs/pg-boss.js";

describe("job queue startup", () => {
  it("rejects emitted registration failures even when the library resolves start", async () => {
    const error = Object.assign(new Error("session pool exhausted"), {
      code: "XX000",
    });
    const boss = Object.assign(new EventEmitter(), {
      async start() {
        this.emit("error", error);
        return this;
      },
    });
    await expect(
      startJobQueue(boss as Parameters<typeof startJobQueue>[0]),
    ).rejects.toBe(error);
    expect(boss.listenerCount("error")).toBe(0);
  });
  it("completes registration and removes its temporary listener", async () => {
    const boss = Object.assign(new EventEmitter(), {
      async start() {
        return this;
      },
    });
    await expect(
      startJobQueue(boss as Parameters<typeof startJobQueue>[0]),
    ).resolves.toBeUndefined();
    expect(boss.listenerCount("error")).toBe(0);
  });
});
