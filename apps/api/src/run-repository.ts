import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const RUN_STATE_SNAPSHOT_VERSION = "run-state-snapshot-v1";

export type PersistedDatasetSide = "A" | "B";

export interface PendingSourceWrite {
  side: PersistedDatasetSide;
  bytes: Buffer;
}

export interface PersistedRunStateEnvelope {
  snapshotVersion: typeof RUN_STATE_SNAPSHOT_VERSION;
  runId: string;
  savedAt: string;
  revision: number;
  state: unknown;
}

export interface RunRepository {
  initialize(): Promise<void>;
  loadStates(): Promise<PersistedRunStateEnvelope[]>;
  loadState(runId: string): Promise<PersistedRunStateEnvelope | null>;
  saveState(runId: string, state: unknown, expectedRevision: number): Promise<number>;
  // PostgreSQL can commit the revision and its new immutable source bytes atomically.
  saveStateWithSources?(runId: string, state: unknown, expectedRevision: number, sources: readonly PendingSourceWrite[]): Promise<number>;
  saveSource(runId: string, side: PersistedDatasetSide, bytes: Buffer): Promise<void>;
  readSource(runId: string, side: PersistedDatasetSide): Promise<Buffer>;
  close(): Promise<void>;
}

export class RunRepositoryError extends Error {}
export class RunRevisionConflictError extends RunRepositoryError {}

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
    || (envelope.revision !== undefined && (!Number.isSafeInteger(envelope.revision) || (envelope.revision as number) < 1))
    || !("state" in envelope)
  ) {
    throw new RunRepositoryError("Persisted run state uses an unsupported schema.");
  }
  assertRunId(envelope.runId);
  if (expectedRunId && envelope.runId !== expectedRunId) {
    throw new RunRepositoryError("Persisted run state does not match its directory.");
  }
  return { ...(envelope as unknown as PersistedRunStateEnvelope), revision: (envelope.revision as number | undefined) ?? 1 };
}

export class InMemoryRunRepository implements RunRepository {
  private readonly states = new Map<string, PersistedRunStateEnvelope>();
  private readonly sources = new Map<string, Buffer>();

  async initialize(): Promise<void> {}

  async loadStates(): Promise<PersistedRunStateEnvelope[]> {
    return [...this.states.values()].map((value) => structuredClone(value));
  }

  async loadState(runId: string): Promise<PersistedRunStateEnvelope | null> {
    assertRunId(runId);
    const value = this.states.get(runId);
    return value ? structuredClone(value) : null;
  }

  async saveState(runId: string, state: unknown, expectedRevision: number): Promise<number> {
    assertRunId(runId);
    const current = this.states.get(runId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || (current?.revision ?? 0) !== expectedRevision) {
      throw new RunRevisionConflictError("Run state was changed since it was loaded.");
    }
    const revision = expectedRevision + 1;
    this.states.set(runId, {
      snapshotVersion: RUN_STATE_SNAPSHOT_VERSION,
      runId,
      savedAt: new Date().toISOString(),
      revision,
      state: structuredClone(state),
    });
    return revision;
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
      const state = await this.loadState(entry.name);
      if (state) states.push(state);
    }
    return states.sort((left, right) => left.runId.localeCompare(right.runId));
  }

  async loadState(runId: string): Promise<PersistedRunStateEnvelope | null> {
    assertRunId(runId);
    let text: string;
    try {
      text = await readFile(join(this.root, runId, "state.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RunRepositoryError(`Persisted state for ${runId} is not valid JSON.`);
    }
    return assertEnvelope(parsed, runId);
  }

  async saveState(runId: string, state: unknown, expectedRevision: number): Promise<number> {
    assertRunId(runId);
    const current = await this.loadState(runId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || (current?.revision ?? 0) !== expectedRevision) {
      throw new RunRevisionConflictError("Run state was changed since it was loaded.");
    }
    const directory = resolve(this.root, runId);
    await mkdir(directory, { recursive: true });
    const revision = expectedRevision + 1;
    const envelope: PersistedRunStateEnvelope = {
      snapshotVersion: RUN_STATE_SNAPSHOT_VERSION,
      runId,
      savedAt: new Date().toISOString(),
      revision,
      state,
    };
    const finalPath = join(directory, "state.json");
    const temporaryPath = join(directory, `state.json.tmp-${randomUUID()}`);
    await writeFile(temporaryPath, JSON.stringify(envelope), { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, finalPath);
    return revision;
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
