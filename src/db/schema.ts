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

    -- Conversation index (metadata only — raw data stays in JSONL files)
    CREATE TABLE IF NOT EXISTS conversations (
      session_id    TEXT PRIMARY KEY,
      project_id    TEXT,
      title         TEXT,
      started_at    TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      user_count    INTEGER NOT NULL DEFAULT 0,
      assistant_count INTEGER NOT NULL DEFAULT 0,
      file_path     TEXT NOT NULL,
      file_size     INTEGER NOT NULL DEFAULT 0,
      indexed_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL REFERENCES conversations(session_id) ON DELETE CASCADE,
      role          TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      text_preview  TEXT NOT NULL,
      seq           INTEGER NOT NULL,
      timestamp     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_started ON conversations(started_at);
    CREATE INDEX IF NOT EXISTS idx_conv_messages_session ON conversation_messages(session_id);

    -- Subagent conversations
    CREATE TABLE IF NOT EXISTS conversation_subagents (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      agent_id      TEXT NOT NULL,
      file_path     TEXT NOT NULL,
      file_size     INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      indexed_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_subagents_session ON conversation_subagents(session_id);

    -- Lost sessions (metadata only, JSONL deleted by Claude Code)
    CREATE TABLE IF NOT EXISTS lost_sessions (
      session_id    TEXT PRIMARY KEY,
      project_path  TEXT,
      project_id    TEXT,
      message_count INTEGER,
      first_prompt  TEXT,
      git_branch    TEXT,
      created_at    TEXT,
      modified_at   TEXT,
      source_index  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lost_sessions_project ON lost_sessions(project_id);

    -- Logical project unification
    CREATE TABLE IF NOT EXISTS repositories (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      remote_url  TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_aliases (
      path        TEXT PRIMARY KEY,
      repo_id     TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      first_seen  TEXT NOT NULL,
      last_seen   TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'auto' CHECK(source IN ('auto', 'manual', 'git'))
    );

    CREATE TABLE IF NOT EXISTS project_fingerprints (
      repo_id       TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      hit_count     INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (repo_id, relative_path)
    );

    CREATE INDEX IF NOT EXISTS idx_project_aliases_repo ON project_aliases(repo_id);
    CREATE INDEX IF NOT EXISTS idx_project_fps_repo ON project_fingerprints(repo_id);
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

  // FTS for conversation messages
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(
      text_preview,
      content='conversation_messages',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS conv_msg_ai AFTER INSERT ON conversation_messages BEGIN
      INSERT INTO conversations_fts(rowid, text_preview) VALUES (NEW.id, NEW.text_preview);
    END;

    CREATE TRIGGER IF NOT EXISTS conv_msg_ad AFTER DELETE ON conversation_messages BEGIN
      INSERT INTO conversations_fts(conversations_fts, rowid, text_preview) VALUES ('delete', OLD.id, OLD.text_preview);
    END;
  `);
}
