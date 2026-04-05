import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SqliteMemoryStore } from "../store/sqlite-store.js";
import type { ArchiveStore, ConversationSource } from "../archive/types.js";
import { indexConversations, getRawConversation } from "../conversations.js";

export function registerConversationTools(
  s: McpServer,
  store: SqliteMemoryStore,
  archive: ArchiveStore
) {
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
        await indexConversations(store.database, claudeDir ?? undefined);

        const convSource = source as ConversationSource;
        let query = `SELECT session_id, project_id, file_path, file_size FROM conversations`;
        const conditions: string[] = [];
        const values: unknown[] = [];

        if (sessionId) {
          conditions.push("session_id = ?");
          values.push(sessionId);
        }

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

          if (await archive.exists(archiveKey)) {
            archived.push(`⊘ ${row.session_id} (already archived)`);
            continue;
          }

          const rawData = fs.readFileSync(row.file_path, "utf-8");
          await archive.put(archiveKey, rawData);
          updatePath.run(archiveKey, row.session_id);

          const sizeKb = Math.round(row.file_size / 1024);
          archived.push(`✓ ${row.session_id} → ${archiveKey} (${sizeKb}KB)`);
        }

        // Subagent JONLs
        const subagentRows = store.database.prepare(
          `SELECT id, session_id, agent_id, file_path, file_size FROM conversation_subagents WHERE file_path LIKE ?`
        ).all(`${claudeBase}%`) as Array<{
          id: string; session_id: string; agent_id: string; file_path: string; file_size: number;
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
          } catch { /* File may have been deleted */ }
        }

        // sessions-index.json
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
          content: [{ type: "text" as const, text: `${summary.join(", ")}:\n\n${archived.join("\n")}` }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: String(e) }], isError: true };
      }
    }
  );

  s.tool(
    "conversation_fetch",
    "Fetch a conversation's raw JSONL from the archive (S3 or local).",
    {
      sessionId: z.string().describe("Session ID to fetch"),
    },
    async ({ sessionId }) => {
      try {
        const conv = store.database
          .prepare(`SELECT file_path FROM conversations WHERE session_id = ?`)
          .get(sessionId) as { file_path: string } | undefined;

        if (!conv) {
          return { content: [{ type: "text" as const, text: `Conversation not found: ${sessionId}` }], isError: true };
        }

        if (conv.file_path.startsWith("/")) {
          try {
            const data = fs.readFileSync(conv.file_path, "utf-8");
            return { content: [{ type: "text" as const, text: data }] };
          } catch { /* Fall through to archive */ }
        }

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
}
