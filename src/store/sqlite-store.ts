import Database from "better-sqlite3";
import { ulid } from "ulid";
import { createPatch } from "diff";
import { initializeSchema } from "../db/schema.js";
import type {
  Memory,
  MemoryCreateInput,
  MemoryUpdateInput,
  MemoryVersion,
  MemoryStore,
  SearchQuery,
  ListFilter,
  ChangedBy,
} from "../types.js";

/** Row shape from the memories table */
interface MemoryRow {
  id: string;
  type: string;
  scope: string;
  name: string;
  description: string;
  content: string;
  tags: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  memory_id: string;
  version: number;
  diff: string;
  changed_by: string;
  created_at: string;
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    type: row.type as Memory["type"],
    scope: row.scope as Memory["scope"],
    name: row.name,
    description: row.description,
    content: row.content,
    tags: JSON.parse(row.tags) as string[],
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToVersion(row: VersionRow): MemoryVersion {
  return {
    id: row.id,
    memoryId: row.memory_id,
    version: row.version,
    diff: row.diff,
    changedBy: row.changed_by as MemoryVersion["changedBy"],
    createdAt: row.created_at,
  };
}

export class SqliteMemoryStore implements MemoryStore {
  private db: Database.Database;

  /** Expose the raw DB handle for conversation indexing */
  get database(): Database.Database {
    return this.db;
  }

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    initializeSchema(this.db);
  }

  async create(input: MemoryCreateInput): Promise<Memory> {
    const id = ulid();
    const now = new Date().toISOString();
    const tags = JSON.stringify(input.tags ?? []);
    const scope = input.scope ?? "global";
    const projectId = input.projectId ?? null;

    this.db
      .prepare(
        `INSERT INTO memories (id, type, scope, name, description, content, tags, project_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.type, scope, input.name, input.description, input.content, tags, projectId, now, now);

    // Initial version (v1) — full content as diff
    this.db
      .prepare(
        `INSERT INTO memory_versions (id, memory_id, version, diff, changed_by, created_at)
         VALUES (?, ?, 1, ?, 'system', ?)`
      )
      .run(ulid(), id, createPatch(input.name, "", input.content, "", ""), now);

    // Shared project associations
    if (scope === "shared" && input.sharedProjectIds) {
      const insert = this.db.prepare(
        `INSERT INTO memory_projects (memory_id, project_id) VALUES (?, ?)`
      );
      for (const pid of input.sharedProjectIds) {
        insert.run(id, pid);
      }
    }

    return this.get(id) as Promise<Memory>;
  }

  async get(id: string): Promise<Memory | null> {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  async update(id: string, patch: MemoryUpdateInput, changedBy: ChangedBy = "claude"): Promise<Memory> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);

    const now = new Date().toISOString();
    const updates: string[] = [];
    const values: unknown[] = [];

    if (patch.name !== undefined) {
      updates.push("name = ?");
      values.push(patch.name);
    }
    if (patch.description !== undefined) {
      updates.push("description = ?");
      values.push(patch.description);
    }
    if (patch.content !== undefined) {
      updates.push("content = ?");
      values.push(patch.content);
    }
    if (patch.type !== undefined) {
      updates.push("type = ?");
      values.push(patch.type);
    }
    if (patch.scope !== undefined) {
      updates.push("scope = ?");
      values.push(patch.scope);
    }
    if (patch.tags !== undefined) {
      updates.push("tags = ?");
      values.push(JSON.stringify(patch.tags));
    }
    if (patch.projectId !== undefined) {
      updates.push("project_id = ?");
      values.push(patch.projectId);
    }

    if (updates.length === 0) return existing;

    updates.push("updated_at = ?");
    values.push(now);
    values.push(id);

    this.db.prepare(`UPDATE memories SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    // Record version diff (content changes only)
    if (patch.content !== undefined && patch.content !== existing.content) {
      const lastVersion = this.db
        .prepare(`SELECT MAX(version) as max_v FROM memory_versions WHERE memory_id = ?`)
        .get(id) as { max_v: number } | undefined;
      const nextVersion = (lastVersion?.max_v ?? 0) + 1;
      const diff = createPatch(existing.name, existing.content, patch.content, "", "");

      this.db
        .prepare(
          `INSERT INTO memory_versions (id, memory_id, version, diff, changed_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(ulid(), id, nextVersion, diff, changedBy, now);
    }

    return this.get(id) as Promise<Memory>;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  }

  async search(query: SearchQuery): Promise<Memory[]> {
    const limit = query.limit ?? 20;
    const conditions: string[] = [];
    const values: unknown[] = [];

    // FTS match
    conditions.push(`m.rowid IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)`);
    values.push(query.query);

    if (query.type) {
      conditions.push("m.type = ?");
      values.push(query.type);
    }
    if (query.scope) {
      conditions.push("m.scope = ?");
      values.push(query.scope);
    }
    if (query.projectId) {
      conditions.push("(m.project_id = ? OR m.scope = 'global' OR m.id IN (SELECT memory_id FROM memory_projects WHERE project_id = ?))");
      values.push(query.projectId, query.projectId);
    }

    values.push(limit);

    const sql = `SELECT m.* FROM memories m WHERE ${conditions.join(" AND ")} ORDER BY m.updated_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...values) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  async list(filter: ListFilter): Promise<Memory[]> {
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.type) {
      conditions.push("type = ?");
      values.push(filter.type);
    }
    if (filter.scope) {
      conditions.push("scope = ?");
      values.push(filter.scope);
    }
    if (filter.projectId) {
      conditions.push("(project_id = ? OR scope = 'global' OR id IN (SELECT memory_id FROM memory_projects WHERE project_id = ?))");
      values.push(filter.projectId, filter.projectId);
    }
    if (filter.tags && filter.tags.length > 0) {
      for (const tag of filter.tags) {
        conditions.push("tags LIKE ?");
        values.push(`%"${tag}"%`);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(limit, offset);

    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...values) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  async history(id: string): Promise<MemoryVersion[]> {
    const rows = this.db
      .prepare(`SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version ASC`)
      .all(id) as VersionRow[];
    return rows.map(rowToVersion);
  }

  async restore(id: string, version: number): Promise<Memory> {
    // To restore, we need to replay diffs from v1 up to target version
    // For simplicity in Phase 1, we store full content in the initial diff
    // and subsequent diffs are unified patches. Full replay is Phase 2.
    // For now, just record a version noting the restore action.
    const existing = await this.get(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);

    const targetRow = this.db
      .prepare(`SELECT * FROM memory_versions WHERE memory_id = ? AND version = ?`)
      .get(id, version) as VersionRow | undefined;
    if (!targetRow) throw new Error(`Version ${version} not found for memory ${id}`);

    // TODO: Phase 2 — proper diff replay
    return existing;
  }

  close(): void {
    this.db.close();
  }
}
