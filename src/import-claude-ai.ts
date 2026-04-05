import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { ArchiveStore } from "./archive/types.js";
import type { MemoryStore, MemoryType } from "./types.js";

// --- Types for Claude.ai export ---

interface ClaudeAiConversation {
  uuid: string;
  name: string;
  summary: string;
  created_at: string;
  updated_at: string;
  account: { uuid: string };
  chat_messages: ClaudeAiMessage[];
}

interface ClaudeAiMessage {
  uuid: string;
  text: string;
  content: Array<{ type?: string; text?: string; thinking?: string }>;
  sender: "human" | "assistant";
  created_at: string;
  updated_at: string;
  attachments: Array<{
    file_name?: string;
    file_size?: number;
    file_type?: string;
    extracted_content?: string;
  }>;
  files: unknown[];
}

interface ClaudeAiMemoryExport {
  conversations_memory: string;
  project_memories: Record<string, string>;
  account_uuid: string;
}

interface ClaudeAiProject {
  uuid: string;
  name: string;
  description: string;
  is_private: boolean;
  is_starter_project: boolean;
  prompt_template: string;
  created_at: string;
  updated_at: string;
  creator: { uuid: string; full_name: string };
  docs: Array<{ uuid: string; filename: string; content: string }>;
}

// --- Import conversations ---

export async function importClaudeAiConversations(
  db: Database.Database,
  archive: ArchiveStore,
  exportDir: string
): Promise<{ conversations: number; messages: number; archived: number }> {
  const convFile = path.join(exportDir, "conversations.json");
  if (!fs.existsSync(convFile)) throw new Error(`Not found: ${convFile}`);

  const convs: ClaudeAiConversation[] = JSON.parse(fs.readFileSync(convFile, "utf-8"));

  const insertConv = db.prepare(`
    INSERT OR IGNORE INTO conversations
      (session_id, project_id, title, started_at, message_count, user_count, assistant_count, file_path, file_size, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO conversation_messages (session_id, role, text_preview, seq, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  const existingConv = db.prepare(`SELECT session_id FROM conversations WHERE session_id = ?`);

  let totalConvs = 0;
  let totalMsgs = 0;
  let totalArchived = 0;

  for (const conv of convs) {
    // Skip if already imported
    if (existingConv.get(conv.uuid)) continue;

    const messages = conv.chat_messages ?? [];
    const userCount = messages.filter((m) => m.sender === "human").length;
    const assistantCount = messages.filter((m) => m.sender === "assistant").length;

    // Archive raw conversation as individual JSON
    const archiveKey = `conversations/claude-ai/${conv.uuid}.json`;
    const rawJson = JSON.stringify(conv, null, 2);
    await archive.put(archiveKey, rawJson);
    totalArchived++;

    const txn = db.transaction(() => {
      insertConv.run(
        conv.uuid,
        "claude-ai",  // project_id placeholder
        conv.name || null,
        conv.created_at,
        messages.length,
        userCount,
        assistantCount,
        archiveKey,
        Buffer.byteLength(rawJson, "utf-8"),
        new Date().toISOString()
      );

      let seq = 0;
      for (const msg of messages) {
        // Normalize role: "human" → "user"
        const role = msg.sender === "human" ? "user" : "assistant";

        // Extract text preview
        let text = msg.text ?? "";
        if (!text && msg.content) {
          text = msg.content
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!)
            .join("\n");
        }
        // Strip thinking content from preview
        const preview = text.slice(0, 2000);
        if (preview) {
          insertMsg.run(conv.uuid, role, preview, seq++, msg.created_at);
        }
      }
    });

    txn();
    totalConvs++;
    totalMsgs += messages.length;
  }

  return { conversations: totalConvs, messages: totalMsgs, archived: totalArchived };
}

// --- Import memories ---

export async function importClaudeAiMemories(
  store: MemoryStore,
  exportDir: string,
  projects: ClaudeAiProject[]
): Promise<{ imported: number }> {
  const memFile = path.join(exportDir, "memories.json");
  if (!fs.existsSync(memFile)) return { imported: 0 };

  const mems: ClaudeAiMemoryExport[] = JSON.parse(fs.readFileSync(memFile, "utf-8"));
  if (mems.length === 0) return { imported: 0 };

  const mem = mems[0];
  let imported = 0;

  // Import global conversation memory
  if (mem.conversations_memory) {
    await store.create({
      type: "user" as MemoryType,
      scope: "global",
      name: "Claude.ai conversation memory",
      description: "Global memory from Claude.ai — user context, preferences, work background",
      content: mem.conversations_memory,
      tags: ["imported", "claude-ai", "global-memory"],
    });
    imported++;
  }

  // Import project memories
  const projectMap = new Map(projects.map((p) => [p.uuid, p.name]));

  for (const [projectUuid, memoryContent] of Object.entries(mem.project_memories)) {
    if (!memoryContent) continue;
    const projectName = projectMap.get(projectUuid) ?? projectUuid;

    await store.create({
      type: "project" as MemoryType,
      scope: "project",
      name: `Claude.ai project memory: ${projectName}`,
      description: `Project memory from Claude.ai project "${projectName}"`,
      content: memoryContent,
      projectId: `claude-ai:${projectName}`,
      tags: ["imported", "claude-ai", "project-memory"],
    });
    imported++;
  }

  return { imported };
}

// --- Import projects ---

export async function importClaudeAiProjects(
  store: MemoryStore,
  exportDir: string
): Promise<{ projects: ClaudeAiProject[]; imported: number }> {
  const projFile = path.join(exportDir, "projects.json");
  if (!fs.existsSync(projFile)) return { projects: [], imported: 0 };

  const projects: ClaudeAiProject[] = JSON.parse(fs.readFileSync(projFile, "utf-8"));
  let imported = 0;

  for (const proj of projects) {
    if (proj.is_starter_project) continue; // Skip template projects

    // Import project config as knowledge memory
    const parts: string[] = [];
    parts.push(`# ${proj.name}`);
    if (proj.description) parts.push(`\n${proj.description}`);
    if (proj.prompt_template) {
      parts.push(`\n## System Prompt\n\n${proj.prompt_template}`);
    }
    if (proj.docs && proj.docs.length > 0) {
      parts.push(`\n## Attached Documents`);
      for (const doc of proj.docs) {
        parts.push(`\n### ${doc.filename}\n\n${doc.content.slice(0, 5000)}`);
      }
    }

    await store.create({
      type: "knowledge" as MemoryType,
      scope: "project",
      name: `Claude.ai project: ${proj.name}`,
      description: `Project config from Claude.ai — "${proj.name}" (system prompt + docs)`,
      content: parts.join("\n"),
      projectId: `claude-ai:${proj.name}`,
      tags: ["imported", "claude-ai", "project-config"],
    });
    imported++;
  }

  return { projects, imported };
}
