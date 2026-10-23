import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMatcherRunner, MatcherInterruptedError, MatcherTimeoutError } from "../src/matcher-process.js";
import { spawn } from "node:child_process";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  kill = vi.fn((_signal: string) => {
    // OS child-process close is asynchronous after a kill request.
    queueMicrotask(() => this.emit("close", null));
    return true;
  });
}

const spawnMock = vi.mocked(spawn);

describe("SW-018 real matcher child-process deadline", () => {
  let child: FakeChild;

  beforeEach(() => {
    vi.useFakeTimers();
    child = new FakeChild();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  });

  afterEach(() => {
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  it("kills a hung match child and rejects with a safe timeout error", async () => {
    const running = createMatcherRunner({ matchTimeoutMs: 25 }).match({
      aPath: "a.csv", bPath: "b.csv", mappings: [],
    });
    const rejection = expect(running).rejects.toBeInstanceOf(MatcherTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null);
  });

  it("aborts an active match child on shutdown rather than waiting for its deadline", async () => {
    const controller = new AbortController();
    const running = createMatcherRunner({ matchTimeoutMs: 30_000 }).match({
      aPath: "a.csv", bPath: "b.csv", mappings: [], signal: controller.signal,
    });
    const rejection = expect(running).rejects.toBeInstanceOf(MatcherInterruptedError);
    controller.abort();
    await rejection;
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(30_001);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("accepts a completed profile and clears its deadline", async () => {
    const profile = createMatcherRunner({ profileTimeoutMs: 25 }).profile({
      datasetId: "dataset-1", side: "A", originalFilename: "a.csv",
      sha256: "a".repeat(64), path: "a.csv",
    });
    child.stdout.write(JSON.stringify({
      contractVersion: "1.0.0",
      datasetId: "dataset-1",
      side: "A",
      originalFilename: "a.csv",
      sha256: "a".repeat(64),
      rowCount: 0,
      columns: [{
        name: "id", inferredType: "string",
        nullCount: 0, nullRate: 0, distinctCount: 0, distinctRate: 0,
        samples: [],
      }],
    }));
    child.emit("close", 0);
    await expect(profile).resolves.toMatchObject({ datasetId: "dataset-1" });
    await vi.advanceTimersByTimeAsync(25);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("validates deadlines before spawning the child", () => {
    expect(() => createMatcherRunner({ matchTimeoutMs: 0 })).toThrow();
    expect(() => createMatcherRunner({ profileTimeoutMs: Number.NaN })).toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
