import { createHash } from "node:crypto";

import postgres from "postgres";

import {
  RUN_STATE_SNAPSHOT_VERSION,
  RunRepositoryError,
  RunRevisionConflictError,
  type PersistedDatasetSide,
  type PendingSourceWrite,
  type PersistedRunStateEnvelope,
  type RunRepository,
} from "./run-repository.js";

const SCHEMA_VERSION = 1;

type Database = ReturnType<typeof postgres>;

function assertRunId(runId: string): void {
  if (!/^run-[0-9a-f-]+$/i.test(runId)) throw new RunRepositoryError("Invalid run identifier.");
}

function resultRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RunRepositoryError("Database returned an invalid run revision.");
  }
  return revision;
}

function envelopeFromRow(row: Record<string, unknown>): PersistedRunStateEnvelope {
  const runId = row.run_id;
  if (typeof runId !== "string") throw new RunRepositoryError("Invalid persisted run identifier.");
  assertRunId(runId);
  if (row.snapshot_version !== RUN_STATE_SNAPSHOT_VERSION) {
    throw new RunRepositoryError("Database run snapshot version is not supported.");
  }
  let state: unknown = row.state;
  if (typeof state === "string") {
    try {
      state = JSON.parse(state) as unknown;
    } catch {
      throw new RunRepositoryError("Database run snapshot JSON is malformed.");
    }
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new RunRepositoryError("Database run snapshot is malformed.");
  }
  const saved = row.saved_at;
  const savedAt = saved instanceof Date ? saved.toISOString() : String(saved);
  return {
    runId,
    snapshotVersion: RUN_STATE_SNAPSHOT_VERSION,
    revision: resultRevision(row.revision),
    savedAt,
    state,
  };
}

/**
 * PostgreSQL is authoritative when DATABASE_URL is configured. No filesystem
 * fallback is allowed if initialization, queries, or persistence fail.
 */
export class PostgresRunRepository implements RunRepository {
  private readonly sql: Database;

  constructor(connectionString: string) {
    if (!connectionString) throw new RunRepositoryError("PostgreSQL connection string is missing.");
    this.sql = postgres(connectionString, {
      max: 5,
      prepare: false,
      connect_timeout: 5,
      idle_timeout: 20,
    });
  }

  async initialize(): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(81470513)`;
      await tx`
        CREATE TABLE IF NOT EXISTS samewise_schema_version (
          version integer PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await tx`
        INSERT INTO samewise_schema_version (version)
        VALUES (${SCHEMA_VERSION})
        ON CONFLICT DO NOTHING
      `;
      const versions = await tx`SELECT version FROM samewise_schema_version`;
      if (versions.length !== 1 || Number(versions[0]?.version) !== SCHEMA_VERSION) {
        throw new RunRepositoryError("Unsupported Samewise database schema version.");
      }
      await tx`
        CREATE TABLE IF NOT EXISTS samewise_run_snapshots (
          run_id text PRIMARY KEY,
          revision bigint NOT NULL CHECK (revision > 0),
          snapshot_version text NOT NULL,
          state jsonb NOT NULL,
          saved_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS samewise_source_blobs (
          run_id text NOT NULL,
          side text NOT NULL CHECK (side IN ('A', 'B')),
          sha256 char(64) NOT NULL,
          source_bytes bytea NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (run_id, side)
        )
      `;
    });
  }

  async loadStates(): Promise<PersistedRunStateEnvelope[]> {
    const rows = await this.sql`
      SELECT run_id, revision, snapshot_version, state, saved_at
      FROM samewise_run_snapshots
      ORDER BY run_id
    `;
    return rows.map((row) => envelopeFromRow(row));
  }

  async loadState(runId: string): Promise<PersistedRunStateEnvelope | null> {
    assertRunId(runId);
    const rows = await this.sql`
      SELECT run_id, revision, snapshot_version, state, saved_at
      FROM samewise_run_snapshots WHERE run_id = ${runId}
    `;
    return rows[0] ? envelopeFromRow(rows[0]) : null;
  }

  async saveState(runId: string, state: unknown, expectedRevision: number): Promise<number> {
    return this.saveStateWithSources(runId, state, expectedRevision, []);
  }

  async saveStateWithSources(
    runId: string,
    state: unknown,
    expectedRevision: number,
    sources: readonly PendingSourceWrite[],
  ): Promise<number> {
    assertRunId(runId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new RunRevisionConflictError("Invalid expected run revision.");
    }
    const json = JSON.stringify(state);
    if (json === undefined) throw new RunRepositoryError("Run state could not be serialized.");
    const preparedSources = sources.map(({ side, bytes }) => {
      if (side !== "A" && side !== "B") throw new RunRepositoryError("Invalid source side.");
      if (!Buffer.isBuffer(bytes)) throw new RunRepositoryError("Invalid source bytes.");
      return { side, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    });

    // Revision CAS and immutable source writes must succeed or fail together.
    // Otherwise a losing writer can strand bytes which block the winning run.
    return this.sql.begin(async (tx) => {
      const rows = expectedRevision === 0
        ? await tx`
            INSERT INTO samewise_run_snapshots (run_id, revision, snapshot_version, state)
            VALUES (${runId}, 1, ${RUN_STATE_SNAPSHOT_VERSION}, ${json}::jsonb)
            ON CONFLICT (run_id) DO NOTHING
            RETURNING revision
          `
        : await tx`
            UPDATE samewise_run_snapshots
            SET revision = revision + 1, state = ${json}::jsonb,
                snapshot_version = ${RUN_STATE_SNAPSHOT_VERSION}, saved_at = now()
            WHERE run_id = ${runId} AND revision = ${expectedRevision}
            RETURNING revision
          `;
      if (!rows.length) throw new RunRevisionConflictError("Run revision changed before write.");

      for (const { side, bytes, sha256 } of preparedSources) {
        await tx`
          INSERT INTO samewise_source_blobs (run_id, side, sha256, source_bytes)
          VALUES (${runId}, ${side}, ${sha256}, ${bytes})
          ON CONFLICT (run_id, side) DO NOTHING
        `;
        const existing = await tx`
          SELECT sha256, source_bytes FROM samewise_source_blobs
          WHERE run_id = ${runId} AND side = ${side}
        `;
        const row = existing[0];
        if (!row || row.sha256 !== sha256 || !Buffer.from(row.source_bytes as Uint8Array).equals(bytes)) {
          throw new RunRepositoryError("Immutable source bytes conflict with previously stored data.");
        }
      }
      return resultRevision(rows[0]?.revision);
    });
  }
  async saveSource(runId: string, side: PersistedDatasetSide, bytes: Buffer): Promise<void> {
    assertRunId(runId);
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    await this.sql`
      INSERT INTO samewise_source_blobs (run_id, side, sha256, source_bytes)
      VALUES (${runId}, ${side}, ${fingerprint}, ${bytes})
      ON CONFLICT (run_id, side) DO NOTHING
    `;
    const existing = await this.readSource(runId, side);
    if (!existing.equals(bytes)) {
      throw new RunRepositoryError("Immutable source bytes conflict with previously stored data.");
    }
  }

  async readSource(runId: string, side: PersistedDatasetSide): Promise<Buffer> {
    assertRunId(runId);
    const rows = await this.sql`
      SELECT sha256, source_bytes
      FROM samewise_source_blobs WHERE run_id = ${runId} AND side = ${side}
    `;
    const row = rows[0];
    if (!row) throw new RunRepositoryError("Persisted source bytes were not found.");
    const bytes = Buffer.from(row.source_bytes as Uint8Array);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== row.sha256) throw new RunRepositoryError("Persisted source integrity check failed.");
    return bytes;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
