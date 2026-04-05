import type Database from "better-sqlite3";

/** Initialize database schema — idempotent, safe to call on every startup */
export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL CHECK(type IN ('user', 'feedback', 'project', 'reference', 'knowledge')),
      scope       TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global', 'project', 'shared')),
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL,
      tags        TEXT NOT NULL DEFAULT '[]',
      project_id  TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_projects (
      memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      project_id  TEXT NOT NULL,
      PRIMARY KEY (memory_id, project_id)
    );

    CREATE TABLE IF NOT EXISTS memory_versions (
      id          TEXT PRIMARY KEY,
      memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      diff        TEXT NOT NULL,
      changed_by  TEXT NOT NULL DEFAULT 'claude' CHECK(changed_by IN ('claude', 'user', 'system')),
      created_at  TEXT NOT NULL,
      UNIQUE(memory_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
    CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id);
    CREATE INDEX IF NOT EXISTS idx_memory_versions_memory_id ON memory_versions(memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_projects_project_id ON memory_projects(project_id);
  `);

  // Full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      name,
      description,
      content,
      tags,
      content='memories',
      content_rowid='rowid'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, name, description, content, tags)
      VALUES (NEW.rowid, NEW.name, NEW.description, NEW.content, NEW.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, name, description, content, tags)
      VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.content, OLD.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, name, description, content, tags)
      VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.content, OLD.tags);
      INSERT INTO memories_fts(rowid, name, description, content, tags)
      VALUES (NEW.rowid, NEW.name, NEW.description, NEW.content, NEW.tags);
    END;
  `);
}
