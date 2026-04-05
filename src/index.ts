#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SqliteMemoryStore } from "./store/sqlite-store.js";
import { scanClaudeCodeMemories } from "./import.js";
import { indexConversations, getRawConversation } from "./conversations.js";
import { LocalArchiveStore, S3ArchiveStore } from "./archive/index.js";
import type { ArchiveStore, ConversationSource } from "./archive/index.js";
import { detectUnifyCandidates, linkProject, unlinkProject, listProjects, applyUnification } from "./projects.js";
import { importClaudeAiConversations, importClaudeAiMemories, importClaudeAiProjects } from "./import-claude-ai.js";
import { validateToken, handleDiscovery, handleRegister, handleAuthorizeGet, handleAuthorizePost, handleToken } from "./oauth.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// --- Config ---
const DATA_DIR = process.env.AJISAI_DATA_DIR ?? path.join(os.homedir(), ".ajisai");
const DB_PATH = path.join(DATA_DIR, "ajisai.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

const store = new SqliteMemoryStore(DB_PATH);

// --- Archive Store ---
function createArchiveStore(): ArchiveStore {
  const bucket = process.env.AJISAI_S3_BUCKET;
  if (bucket) {
    return new S3ArchiveStore({
      bucket,
      prefix: process.env.AJISAI_S3_PREFIX ?? "ajisai",
      region: process.env.AJISAI_S3_REGION ?? "auto",
      endpoint: process.env.AJISAI_S3_ENDPOINT,
      accessKeyId: process.env.AJISAI_S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AJISAI_S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY,
    });
  }
  return new LocalArchiveStore(path.join(DATA_DIR, "archives"));
}

const archive = createArchiveStore();

// --- MCP Server (stdio mode) ---
const server = new McpServer({
  name: "ajisai-mcp",
  version: "0.1.0",
});

// --- Tool Registration ---
function registerTools(s: McpServer) {

// --- Tool: memory_create ---
s.tool(
  "memory_create",
  "Create a new memory entry with type, scope, and content",
  {
    type: z.enum(["user", "feedback", "project", "reference", "knowledge"]).describe("Memory type category"),
    scope: z.enum(["global", "project", "shared"]).default("global").describe("Visibility scope"),
    name: z.string().describe("Short name for the memory"),
    description: z.string().describe("One-line description for relevance matching"),
    content: z.string().describe("Full memory content (Markdown)"),
    tags: z.array(z.string()).optional().describe("Tags for filtering"),
    projectId: z.string().optional().describe("Project ID (required if scope is 'project')"),
    sharedProjectIds: z.array(z.string()).optional().describe("Project IDs to share with (for scope 'shared')"),
  },
  async (params) => {
    const memory = await store.create(params);
    return { content: [{ type: "text" as const, text: JSON.stringify(memory, null, 2) }] };
  }
);

// --- Tool: memory_get ---
s.tool(
  "memory_get",
  "Get a memory by its ID",
  {
    id: z.string().describe("Memory ID (ULID)"),
  },
  async ({ id }) => {
    const memory = await store.get(id);
    if (!memory) {
      return { content: [{ type: "text" as const, text: `Memory not found: ${id}` }], isError: true };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(memory, null, 2) }] };
  }
);

// --- Tool: memory_update ---
s.tool(
  "memory_update",
  "Update an existing memory. Automatically records version history for content changes.",
  {
    id: z.string().describe("Memory ID to update"),
    name: z.string().optional(),
    description: z.string().optional(),
    content: z.string().optional(),
    type: z.enum(["user", "feedback", "project", "reference", "knowledge"]).optional(),
    scope: z.enum(["global", "project", "shared"]).optional(),
    tags: z.array(z.string()).optional(),
    projectId: z.string().optional(),
    changedBy: z.enum(["claude", "user", "system"]).default("claude"),
  },
  async ({ id, changedBy, ...patch }) => {
    try {
      const memory = await store.update(id, patch, changedBy);
      return { content: [{ type: "text" as const, text: JSON.stringify(memory, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  }
);

// --- Tool: memory_delete ---
s.tool(
  "memory_delete",
  "Delete a memory by ID",
  {
    id: z.string().describe("Memory ID to delete"),
  },
  async ({ id }) => {
    await store.delete(id);
    return { content: [{ type: "text" as const, text: `Deleted: ${id}` }] };
  }
);

// --- Tool: memory_search ---
s.tool(
  "memory_search",
  "Full-text search across memories",
  {
    query: z.string().describe("Search query (FTS5 syntax supported)"),
    type: z.enum(["user", "feedback", "project", "reference", "knowledge"]).optional(),
    scope: z.enum(["global", "project", "shared"]).optional(),
    projectId: z.string().optional().describe("Filter to memories visible to this project"),
    limit: z.number().optional().default(20),
  },
  async (params) => {
    try {
      const results = await store.search(params);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  }
);

// --- Tool: memory_list ---
s.tool(
  "memory_list",
  "List memories with optional filters",
  {
    type: z.enum(["user", "feedback", "project", "reference", "knowledge"]).optional(),
    scope: z.enum(["global", "project", "shared"]).optional(),
    projectId: z.string().optional(),
    tags: z.array(z.string()).optional(),
    limit: z.number().optional().default(50),
    offset: z.number().optional().default(0),
  },
  async (params) => {
    const results = await store.list(params);
    return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
  }
);

// --- Tool: memory_history ---
s.tool(
  "memory_history",
  "Get version history of a specific memory",
  {
    id: z.string().describe("Memory ID"),
  },
  async ({ id }) => {
    const versions = await store.history(id);
    return { content: [{ type: "text" as const, text: JSON.stringify(versions, null, 2) }] };
  }
);

// --- Tool: memory_restore ---
s.tool(
  "memory_restore",
  "Restore a memory to a specific version",
  {
    id: z.string().describe("Memory ID"),
    version: z.number().describe("Version number to restore to"),
  },
  async ({ id, version }) => {
    try {
      const memory = await store.restore(id, version);
      return { content: [{ type: "text" as const, text: JSON.stringify(memory, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  }
);

// --- Tool: memory_import ---
s.tool(
  "memory_import",
  "Import memories from Claude Code's local memory files (~/.claude/projects/*/memory/). Scans all projects and imports markdown files with frontmatter.",
  {
    claudeDir: z.string().optional().describe("Custom path to Claude projects dir (default: ~/.claude/projects)"),
    dryRun: z.boolean().optional().default(false).describe("If true, list what would be imported without actually importing"),
  },
  async ({ claudeDir, dryRun }) => {
    try {
      const files = scanClaudeCodeMemories(claudeDir ?? undefined);
      if (files.length === 0) {
        return { content: [{ type: "text" as const, text: "No Claude Code memory files found." }] };
      }

      if (dryRun) {
        const summary = files.map((f: { type: string; name: string; projectId: string; filePath: string }) => `[${f.type}] ${f.name} (project: ${f.projectId}) — ${f.filePath}`);
        return { content: [{ type: "text" as const, text: `Found ${files.length} memories:\n\n${summary.join("\n")}` }] };
      }

      const imported: string[] = [];
      for (const f of files) {
        const validTypes = ["user", "feedback", "project", "reference", "knowledge"] as const;
        const memType = validTypes.includes(f.type as typeof validTypes[number])
          ? (f.type as typeof validTypes[number])
          : "knowledge";

        const memory = await store.create({
          type: memType,
          scope: "project",
          name: f.name,
          description: f.description,
          content: f.content,
          projectId: f.projectId,
          tags: ["imported", "claude-code"],
        });
        imported.push(`✓ ${memory.id} — [${memType}] ${f.name} (project: ${f.projectId})`);
      }

      return {
        content: [{ type: "text" as const, text: `Imported ${imported.length} memories:\n\n${imported.join("\n")}` }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  }
);

// --- Tool: conversation_index ---
s.tool(
  "conversation_index",
  "Scan and index Claude Code conversation JSONL files. Raw data stays on disk; only metadata and message previews are indexed for search.",
  {
    claudeDir: z.string().optional().describe("Custom path to Claude projects dir (default: ~/.claude/projects)"),
  },
  async ({ claudeDir }) => {
    try {
      const result = await indexConversations(store.database, claudeDir ?? undefined);
      return {
        content: [{
          type: "text" as const,
          text: `Indexed ${result.indexed} conversations (${result.skipped} unchanged, skipped).`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  }
);

// --- Tool: conversation_list ---
s.tool(
  "conversation_list",
  "List indexed conversations with optional project filter",
  {
    projectId: z.string().optional(),
    limit: z.number().optional().default(30),
    offset: z.number().optional().default(0),
  },
  async ({ projectId, limit, offset }) => {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (projectId) {
      conditions.push("project_id = ?");
      values.push(projectId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    values.push(limit, offset);

    const rows = store.database
      .prepare(`SELECT session_id, project_id, title, started_at, message_count, user_count, assistant_count, file_size FROM conversations ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(...values);
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  }
);

// --- Tool: conversation_get ---
s.tool(
  "conversation_get",
  "Get a conversation's indexed messages or raw JSONL data",
  {
    sessionId: z.string().describe("Session ID"),
    raw: z.boolean().optional().default(false).describe("If true, return the raw JSONL content"),
  },
  async ({ sessionId, raw }) => {
    if (raw) {
      const content = getRawConversation(store.database, sessionId);
      if (!content) {
        return { content: [{ type: "text" as const, text: `Conversation not found: ${sessionId}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: content }] };
    }

    const conv = store.database
      .prepare(`SELECT * FROM conversations WHERE session_id = ?`)
      .get(sessionId);
    if (!conv) {
      return { content: [{ type: "text" as const, text: `Conversation not found: ${sessionId}` }], isError: true };
    }

    const messages = store.database
      .prepare(`SELECT role, text_preview, seq, timestamp FROM conversation_messages WHERE session_id = ? ORDER BY seq`)
      .all(sessionId);

    return { content: [{ type: "text" as const, text: JSON.stringify({ conversation: conv, messages }, null, 2) }] };
  }
);

// --- Tool: conversation_search ---
s.tool(
  "conversation_search",
  "Full-text search across conversation messages",
  {
    query: z.string().describe("Search query"),
    projectId: z.string().optional(),
    limit: z.number().optional().default(20),
  },
  async ({ query, projectId, limit }) => {
    try {
      let sql = `
        SELECT cm.session_id, cm.role, cm.text_preview, cm.seq, c.title, c.project_id, c.started_at
        FROM conversation_messages cm
        JOIN conversations c ON c.session_id = cm.session_id
        WHERE cm.id IN (SELECT rowid FROM conversations_fts WHERE conversations_fts MATCH ?)
      `;
      const values: unknown[] = [query];

      if (projectId) {
        sql += " AND c.project_id = ?";
        values.push(projectId);
      }

      sql += " ORDER BY c.started_at DESC LIMIT ?";
      values.push(limit);

      const rows = store.database.prepare(sql).all(...values);
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  }
);

// --- Tool: conversation_archive ---
s.tool(
  "conversation_archive",
  "Archive Claude Code conversation JSONL files to S3 (or local archive). Raw data is copied as-is; DB file_path is updated to point to the archive.",
  {
    source: z.enum(["claude-code", "claude-web", "claude-ios"]).default("claude-code").describe("Source of conversation data"),
    sessionId: z.string().optional().describe("Archive a specific session (default: archive all unarchived)"),
    claudeDir: z.string().optional().describe("Custom path to Claude projects dir"),
  },
  async ({ source, sessionId, claudeDir }) => {
    try {
      // Index first to ensure DB is up to date
      await indexConversations(store.database, claudeDir ?? undefined);

      const convSource = source as ConversationSource;
      let query = `SELECT session_id, project_id, file_path, file_size FROM conversations`;
      const conditions: string[] = [];
      const values: unknown[] = [];

      if (sessionId) {
        conditions.push("session_id = ?");
        values.push(sessionId);
      }

      // Only archive conversations whose file_path still points to the original Claude dir
      const claudeBase = claudeDir ?? path.join(os.homedir(), ".claude");
      conditions.push("file_path LIKE ?");
      values.push(`${claudeBase}%`);

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }

      const rows = store.database.prepare(query).all(...values) as Array<{
        session_id: string;
        project_id: string;
        file_path: string;
        file_size: number;
      }>;

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: "No conversations to archive." }] };
      }

      const updatePath = store.database.prepare(
        `UPDATE conversations SET file_path = ? WHERE session_id = ?`
      );

      const archived: string[] = [];
      for (const row of rows) {
        const archiveKey = `conversations/${convSource}/${row.project_id}/${row.session_id}.jsonl`;

        // Skip if already archived
        if (await archive.exists(archiveKey)) {
          archived.push(`⊘ ${row.session_id} (already archived)`);
          continue;
        }

        // Read raw data and archive it
        const rawData = fs.readFileSync(row.file_path, "utf-8");
        await archive.put(archiveKey, rawData);

        // Update DB to point to archive key
        updatePath.run(archiveKey, row.session_id);

        const sizeKb = Math.round(row.file_size / 1024);
        archived.push(`✓ ${row.session_id} → ${archiveKey} (${sizeKb}KB)`);
      }

      // Archive subagent JONLs
      const subagentRows = store.database.prepare(
        `SELECT id, session_id, agent_id, file_path, file_size FROM conversation_subagents WHERE file_path LIKE ?`
      ).all(`${claudeBase}%`) as Array<{
        id: string;
        session_id: string;
        agent_id: string;
        file_path: string;
        file_size: number;
      }>;

      const updateSubPath = store.database.prepare(
        `UPDATE conversation_subagents SET file_path = ? WHERE id = ?`
      );

      let subarchived = 0;
      for (const sub of subagentRows) {
        const projectRow = store.database.prepare(
          `SELECT project_id FROM conversations WHERE session_id = ?`
        ).get(sub.session_id) as { project_id: string } | undefined;
        const pid = projectRow?.project_id ?? "unknown";

        const subKey = `conversations/${convSource}/${pid}/${sub.session_id}/subagents/${sub.agent_id}.jsonl`;

        if (await archive.exists(subKey)) continue;

        try {
          const rawData = fs.readFileSync(sub.file_path, "utf-8");
          await archive.put(subKey, rawData);
          updateSubPath.run(subKey, sub.id);
          subarchived++;
        } catch {
          // File may have been deleted
        }
      }

      // Archive sessions-index.json files for metadata preservation
      const projDirs = fs.readdirSync(path.join(claudeBase, "projects"));
      let indexArchived = 0;
      for (const projDir of projDirs) {
        const indexFile = path.join(claudeBase, "projects", projDir, "sessions-index.json");
        if (!fs.existsSync(indexFile)) continue;
        const indexKey = `metadata/${convSource}/${projDir}/sessions-index.json`;
        if (await archive.exists(indexKey)) continue;
        const data = fs.readFileSync(indexFile, "utf-8");
        await archive.put(indexKey, data);
        indexArchived++;
      }

      const summary = [`Archived ${archived.length} conversations`];
      if (subarchived > 0) summary.push(`${subarchived} subagent logs`);
      if (indexArchived > 0) summary.push(`${indexArchived} session indexes`);

      return {
        content: [{
          type: "text" as const,
          text: `${summary.join(", ")}:\n\n${archived.join("\n")}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  }
);

// --- Tool: conversation_fetch ---
s.tool(
  "conversation_fetch",
  "Fetch a conversation's raw JSONL from the archive (S3 or local). Use this when the original file may have been moved.",
  {
    sessionId: z.string().describe("Session ID to fetch"),
  },
  async ({ sessionId }) => {
    try {
      // First check if we have a direct file_path that's an archive key
      const conv = store.database
        .prepare(`SELECT file_path FROM conversations WHERE session_id = ?`)
        .get(sessionId) as { file_path: string } | undefined;

      if (!conv) {
        return { content: [{ type: "text" as const, text: `Conversation not found: ${sessionId}` }], isError: true };
      }

      // If file_path is an absolute path, try reading directly
      if (conv.file_path.startsWith("/")) {
        try {
          const data = fs.readFileSync(conv.file_path, "utf-8");
          return { content: [{ type: "text" as const, text: data }] };
        } catch {
          // Fall through to archive
        }
      }

      // Otherwise, treat file_path as an archive key
      const data = await archive.get(conv.file_path);
      if (!data) {
        return { content: [{ type: "text" as const, text: `Archive not found: ${conv.file_path}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: data }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  }
);

// --- Tool: import_claude_ai ---
s.tool(
  "import_claude_ai",
  "Import Claude.ai export data (conversations, memories, projects). Provide the path to the extracted export directory.",
  {
    exportDir: z.string().describe("Path to extracted export directory (e.g. ~/Downloads/data-2026-...)"),
    dryRun: z.boolean().optional().default(false).describe("Preview what would be imported without importing"),
    skipConversations: z.boolean().optional().default(false).describe("Skip conversation import"),
    skipMemories: z.boolean().optional().default(false).describe("Skip memory import"),
    skipProjects: z.boolean().optional().default(false).describe("Skip project import"),
  },
  async ({ exportDir, dryRun, skipConversations, skipMemories, skipProjects }) => {
    try {
      // Resolve ~ in path
      const dir = exportDir.replace(/^~/, os.homedir());

      if (!fs.existsSync(dir)) {
        return { content: [{ type: "text" as const, text: `Directory not found: ${dir}` }], isError: true };
      }

      if (dryRun) {
        const lines: string[] = ["Dry run — would import:"];
        const convFile = path.join(dir, "conversations.json");
        if (fs.existsSync(convFile)) {
          const convs = JSON.parse(fs.readFileSync(convFile, "utf-8"));
          lines.push(`  conversations.json: ${convs.length} conversations`);
        }
        const memFile = path.join(dir, "memories.json");
        if (fs.existsSync(memFile)) {
          const mems = JSON.parse(fs.readFileSync(memFile, "utf-8"));
          const projMemCount = mems[0] ? Object.keys(mems[0].project_memories ?? {}).length : 0;
          lines.push(`  memories.json: 1 global memory + ${projMemCount} project memories`);
        }
        const projFile = path.join(dir, "projects.json");
        if (fs.existsSync(projFile)) {
          const projs = JSON.parse(fs.readFileSync(projFile, "utf-8"));
          const userProjs = projs.filter((p: { is_starter_project: boolean }) => !p.is_starter_project);
          lines.push(`  projects.json: ${userProjs.length} projects (system prompts + docs)`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }

      const results: string[] = [];

      // 1. Import projects first (needed for memory project name resolution)
      let projects: Array<{ uuid: string; name: string; is_starter_project: boolean }> = [];
      if (!skipProjects) {
        const projResult = await importClaudeAiProjects(store, dir);
        projects = projResult.projects;
        results.push(`✓ Projects: ${projResult.imported} imported`);
      } else {
        // Still need project list for memory import
        const projFile = path.join(dir, "projects.json");
        if (fs.existsSync(projFile)) {
          projects = JSON.parse(fs.readFileSync(projFile, "utf-8"));
        }
      }

      // 2. Import memories
      if (!skipMemories) {
        const memResult = await importClaudeAiMemories(store, dir, projects as never);
        results.push(`✓ Memories: ${memResult.imported} imported`);
      }

      // 3. Import conversations
      if (!skipConversations) {
        const convResult = await importClaudeAiConversations(store.database, archive, dir);
        results.push(`✓ Conversations: ${convResult.conversations} indexed, ${convResult.messages} messages, ${convResult.archived} archived`);
      }

      return { content: [{ type: "text" as const, text: results.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  }
);

// --- Tool: project_unify ---
s.tool(
  "project_unify",
  "Detect scattered project directories that likely belong to the same repository, using file path fingerprinting and timeline analysis. Returns candidates for unification.",
  {
    threshold: z.number().optional().default(0.2).describe("Jaccard similarity threshold (0-1, default 0.2)"),
    apply: z.boolean().optional().default(false).describe("If true, automatically apply all detected unifications"),
  },
  async ({ threshold, apply }) => {
    try {
      // Ensure conversations are indexed first
      await indexConversations(store.database);

      const candidates = await detectUnifyCandidates(store.database, threshold);

      if (candidates.length === 0) {
        return { content: [{ type: "text" as const, text: "No unification candidates detected." }] };
      }

      if (apply) {
        const results: string[] = [];
        for (const c of candidates) {
          if (!c.existingRepoId) {
            const repo = applyUnification(store.database, c.paths, c.suggestedName);
            results.push(`✓ ${repo.name} — unified ${c.paths.length} paths (similarity: ${(c.similarity * 100).toFixed(0)}%)`);
            for (const p of c.paths) {
              results.push(`    ${p}`);
            }
          }
        }
        return { content: [{ type: "text" as const, text: `Applied ${results.length ? results.join("\n") : "no new unifications"}` }] };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(candidates, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  }
);

// --- Tool: project_link ---
s.tool(
  "project_link",
  "Manually link a directory path to a logical project (repository). Creates the repository if it doesn't exist.",
  {
    path: z.string().describe("Absolute directory path to link"),
    repoName: z.string().describe("Logical project name"),
    remoteUrl: z.string().optional().describe("Git remote URL if available"),
  },
  async ({ path: projectPath, repoName, remoteUrl }) => {
    try {
      const repo = linkProject(store.database, projectPath, repoName, { remoteUrl, source: "manual" });
      return { content: [{ type: "text" as const, text: `Linked ${projectPath} → ${repo.name} (${repo.id})` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  }
);

// --- Tool: project_unlink ---
s.tool(
  "project_unlink",
  "Remove a directory path from its logical project association.",
  {
    path: z.string().describe("Directory path to unlink"),
  },
  async ({ path: projectPath }) => {
    const removed = unlinkProject(store.database, projectPath);
    return {
      content: [{
        type: "text" as const,
        text: removed ? `Unlinked: ${projectPath}` : `Not found: ${projectPath}`,
      }],
    };
  }
);

// --- Tool: project_list ---
s.tool(
  "project_list",
  "List all logical projects (repositories) with their directory aliases and session counts.",
  {},
  async () => {
    const projects = listProjects(store.database);

    if (projects.length === 0) {
      return { content: [{ type: "text" as const, text: "No projects registered. Run project_unify to detect candidates." }] };
    }

    const lines: string[] = [];
    for (const p of projects) {
      lines.push(`${p.name}${p.remoteUrl ? ` (${p.remoteUrl})` : ""}`);
      for (const a of p.aliases) {
        lines.push(`  ├── ${a.path} [${a.source}] ${a.firstSeen.slice(0, 10)}~${a.lastSeen.slice(0, 10)}`);
      }
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

} // end registerTools

// Register tools on the default stdio server
registerTools(server);

// --- Start ---
const MODE = process.env.AJISAI_TRANSPORT ?? (process.argv.includes("--http") ? "http" : "stdio");
const PORT = parseInt(process.env.AJISAI_PORT ?? "3000", 10);

async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const archiveType = process.env.AJISAI_S3_BUCKET ? `s3://${process.env.AJISAI_S3_BUCKET}` : "local";
  console.error(`ajisai-mcp started [stdio] (db: ${DB_PATH}, archive: ${archiveType})`);
}

async function startHttp() {
  const app = new Hono();

  // --- Auth (OAuth 2.0 + static Bearer) ---
  const AUTH_PASSWORD = process.env.AJISAI_AUTH_PASSWORD;
  const BASE_URL = process.env.AJISAI_BASE_URL ?? `http://localhost:${PORT}`;

  const authEnabled = !!(AUTH_PASSWORD || process.env.AJISAI_AUTH_TOKEN);

  // OAuth endpoints
  if (AUTH_PASSWORD) {
    app.get("/.well-known/oauth-authorization-server", (c) => handleDiscovery(c, BASE_URL));
    app.post("/register", (c) => handleRegister(c));
    app.get("/authorize", (c) => handleAuthorizeGet(c, AUTH_PASSWORD));
    app.post("/authorize", (c) => handleAuthorizePost(c, AUTH_PASSWORD));
    app.post("/token", (c) => handleToken(c));
    console.error(`OAuth enabled (password: set, base: ${BASE_URL})`);
  } else if (process.env.AJISAI_AUTH_TOKEN) {
    console.error(`Auth enabled (static Bearer token)`);
  } else {
    console.error(`⚠ Auth disabled — set AJISAI_AUTH_PASSWORD or AJISAI_AUTH_TOKEN`);
  }

  // Session management
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();

  // Auth check helper
  function checkAuth(req: Request): Response | null {
    if (!authEnabled) return null;
    const auth = req.headers.get("authorization") ?? undefined;
    if (auth && validateToken(auth)) return null;
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null },
      { status: 401 }
    );
  }

  app.post("/mcp", async (c) => {
    const rejected = checkAuth(c.req.raw);
    if (rejected) return rejected;

    const sessionId = c.req.header("mcp-session-id");
    const body = await c.req.json();
    // Reconstruct Request with body (Hono already consumed it)
    const reqWithBody = new Request(c.req.url, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    });

    if (sessionId && transports.has(sessionId)) {
      const transport = transports.get(sessionId)!;
      return transport.handleRequest(reqWithBody);
    }

    if (!sessionId && isInitializeRequest(body)) {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      const sessionServer = new McpServer({
        name: "ajisai-mcp",
        version: "0.1.0",
      });

      registerTools(sessionServer);
      await sessionServer.connect(transport);
      return transport.handleRequest(reqWithBody);
    }

    return c.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: null },
      400
    );
  });

  app.get("/mcp", async (c) => {
    const rejected = checkAuth(c.req.raw);
    if (rejected) return rejected;
    const sessionId = c.req.header("mcp-session-id");
    if (!sessionId || !transports.has(sessionId)) {
      return c.body(null, 400);
    }
    return transports.get(sessionId)!.handleRequest(c.req.raw);
  });

  app.delete("/mcp", async (c) => {
    const rejected = checkAuth(c.req.raw);
    if (rejected) return rejected;
    const sessionId = c.req.header("mcp-session-id");
    if (!sessionId || !transports.has(sessionId)) {
      return c.body(null, 400);
    }
    return transports.get(sessionId)!.handleRequest(c.req.raw);
  });

  app.get("/health", (c) => {
    return c.json({ status: "ok", sessions: transports.size });
  });

  serve({ fetch: app.fetch, port: PORT }, () => {
    const archiveType = process.env.AJISAI_S3_BUCKET ? `s3://${process.env.AJISAI_S3_BUCKET}` : "local";
    console.error(`ajisai-mcp started [http://localhost:${PORT}/mcp] (db: ${DB_PATH}, archive: ${archiveType})`);
  });
}

async function main() {
  if (MODE === "http") {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
