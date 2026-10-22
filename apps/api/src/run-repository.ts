import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const RUN_STATE_SNAPSHOT_VERSION = "run-state-snapshot-v1";

export type PersistedDatasetSide = "A" | "B";

export interface PersistedRunStateEnvelope {
  snapshotVersion: typeof RUN_STATE_SNAPSHOT_VERSION;
  runId: string;
  savedAt: string;
  state: unknown;
}

export interface RunRepository {
  initialize(): Promise<void>;
  loadStates(): Promise<PersistedRunStateEnvelope[]>;
  saveState(runId: string, state: unknown): Promise<void>;
  saveSource(runId: string, side: PersistedDatasetSide, bytes: Buffer): Promise<void>;
  readSource(runId: string, side: PersistedDatasetSide): Promise<Buffer>;
  close(): Promise<void>;
}

export class RunRepositoryError extends Error {}

function assertRunId(runId: string): void {
  if (!/^run-[0-9a-f-]+$/i.test(runId)) {
    throw new RunRepositoryError("Persisted run ID is invalid.");
  }
}

function assertEnvelope(value: unknown, expectedRunId?: string): PersistedRunStateEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RunRepositoryError("Persisted run state is malformed.");
  }
  const envelope = value as Record<string, unknown>;
  if (
    envelope.snapshotVersion !== RUN_STATE_SNAPSHOT_VERSION
    || typeof envelope.runId !== "string"
    || typeof envelope.savedAt !== "string"
    || !("state" in envelope)
  ) {
    throw new RunRepositoryError("Persisted run state uses an unsupported schema.");
  }
  assertRunId(envelope.runId);
  if (expectedRunId && envelope.runId !== expectedRunId) {
    throw new RunRepositoryError("Persisted run state does not match its directory.");
  }
  return envelope as unknown as PersistedRunStateEnvelope;
}

export class InMemoryRunRepository implements RunRepository {
  private readonly states = new Map<string, PersistedRunStateEnvelope>();
  private readonly sources = new Map<string, Buffer>();

  async initialize(): Promise<void> {}

  async loadStates(): Promise<PersistedRunStateEnvelope[]> {
    return [...this.states.values()].map((value) => structuredClone(value));
  }

  async saveState(runId: string, state: unknown): Promise<void> {
    assertRunId(runId);
    this.states.set(runId, {
      snapshotVersion: RUN_STATE_SNAPSHOT_VERSION,
      runId,
      savedAt: new Date().toISOString(),
      state: structuredClone(state),
    });
  }

  async saveSource(runId: string, side: PersistedDatasetSide, bytes: Buffer): Promise<void> {
    assertRunId(runId);
    const key = `${runId}:${side}`;
    const existing = this.sources.get(key);
    if (existing && !existing.equals(bytes)) {
      throw new RunRepositoryError("Immutable persisted source bytes do not match.");
    }
    if (!existing) this.sources.set(key, Buffer.from(bytes));
  }

  async readSource(runId: string, side: PersistedDatasetSide): Promise<Buffer> {
    assertRunId(runId);
    const value = this.sources.get(`${runId}:${side}`);
    if (!value) throw new RunRepositoryError("Persisted source bytes were not found.");
    return Buffer.from(value);
  }

  async close(): Promise<void> {}
}

export class FileRunRepository implements RunRepository {
  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async loadStates(): Promise<PersistedRunStateEnvelope[]> {
    await this.initialize();
    const entries = await readdir(this.root, { withFileTypes: true });
    const states: PersistedRunStateEnvelope[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("run-")) continue;
      assertRunId(entry.name);
      const statePath = join(this.root, entry.name, "state.json");
      let text: string;
      try {
        text = await readFile(statePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new RunRepositoryError(`Persisted state for ${entry.name} is not valid JSON.`);
      }
      states.push(assertEnvelope(parsed, entry.name));
    }
    return states.sort((left, right) => left.runId.localeCompare(right.runId));
  }

  async saveState(runId: string, state: unknown): Promise<void> {
    assertRunId(runId);
    const directory = resolve(this.root, runId);
    await mkdir(directory, { recursive: true });
    const envelope: PersistedRunStateEnvelope = {
      snapshotVersion: RUN_STATE_SNAPSHOT_VERSION,
      runId,
      savedAt: new Date().toISOString(),
      state,
    };
    const finalPath = join(directory, "state.json");
    const temporaryPath = join(directory, `state.json.tmp-${process.pid}-${Date.now()}`);
    await writeFile(temporaryPath, JSON.stringify(envelope), { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, finalPath);
  }

  async saveSource(runId: string, side: PersistedDatasetSide, bytes: Buffer): Promise<void> {
    assertRunId(runId);
    const directory = resolve(this.root, runId);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `source-${side}.csv`);
    try {
      await writeFile(path, bytes, { flag: "wx" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = await readFile(path);
    if (!existing.equals(bytes)) {
      throw new RunRepositoryError("Immutable persisted source bytes do not match.");
    }
  }

  async readSource(runId: string, side: PersistedDatasetSide): Promise<Buffer> {
    assertRunId(runId);
    try {
      return await readFile(join(resolve(this.root, runId), `source-${side}.csv`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RunRepositoryError("Persisted source bytes were not found.");
      }
      throw error;
    }
  }

  async close(): Promise<void> {}
}
