import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type Database from "better-sqlite3";

/** Extracted message from a conversation JSONL */
interface ConversationRecord {
  type?: string;
  sessionId?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  aiTitle?: string;
  timestamp?: string;
}

interface IndexedConversation {
  sessionId: string;
  projectId: string;
  title: string | null;
  startedAt: string;
  messageCount: number;
  userCount: number;
  assistantCount: number;
  filePath: string;
  fileSize: number;
}

/** Extract text from a message content array */
function extractText(content: Array<{ type?: string; text?: string }> | undefined): string {
  if (!content) return "";
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n")
    .slice(0, 2000); // Preview limit
}

/** Extract project ID from Claude Code's encoded directory name */
function extractProjectId(dirName: string): string {
  const reconstructed = dirName.replace(/^-/, "/").replace(/-/g, "/");
  const segments = reconstructed.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 1; i--) {
    const parentPath = "/" + segments.slice(0, i).join("/");
    try {
      if (fs.statSync(parentPath).isDirectory()) {
        return segments.slice(i).join("-");
      }
    } catch {
      continue;
    }
  }
  return segments[segments.length - 1] || dirName;
}

/** Parse a single JSONL conversation file and extract metadata + messages */
async function parseConversationFile(
  filePath: string
): Promise<{
  title: string | null;
  messages: Array<{ role: string; text: string; seq: number; timestamp?: string }>;
  startedAt: string | null;
}> {
  const input = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let title: string | null = null;
  let startedAt: string | null = null;
  const messages: Array<{ role: string; text: string; seq: number; timestamp?: string }> = [];
  let seq = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const rec: ConversationRecord = JSON.parse(line);

      if (rec.type === "ai-title" && rec.aiTitle) {
        title = rec.aiTitle;
      }

      if (rec.type === "queue-operation" && rec.timestamp && !startedAt) {
        startedAt = rec.timestamp;
      }

      if ((rec.type === "user" || rec.type === "assistant") && rec.message?.content) {
        const text = extractText(rec.message.content);
        if (text) {
          // Strip system tags from preview
          const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
          if (cleaned) {
            messages.push({
              role: rec.type,
              text: cleaned,
              seq: seq++,
              timestamp: rec.timestamp ?? undefined,
            });
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { title, messages, startedAt };
}

/** Scan and index all Claude Code conversations into the database */
export async function indexConversations(
  db: Database.Database,
  claudeDir?: string
): Promise<{ indexed: number; skipped: number }> {
  const baseDir = claudeDir ?? path.join(process.env.HOME ?? "", ".claude", "projects");
  if (!fs.existsSync(baseDir)) return { indexed: 0, skipped: 0 };

  const insertConv = db.prepare(`
    INSERT OR REPLACE INTO conversations
      (session_id, project_id, title, started_at, message_count, user_count, assistant_count, file_path, file_size, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO conversation_messages (session_id, role, text_preview, seq, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);

  const deleteMessages = db.prepare(`DELETE FROM conversation_messages WHERE session_id = ?`);

  const existingConv = db.prepare(`SELECT session_id, file_size FROM conversations WHERE session_id = ?`);

  let indexed = 0;
  let skipped = 0;

  const projectDirs = fs.readdirSync(baseDir);

  for (const projDir of projectDirs) {
    const projPath = path.join(baseDir, projDir);
    if (!fs.statSync(projPath).isDirectory()) continue;

    const projectId = extractProjectId(projDir);
    const files = fs.readdirSync(projPath).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      const filePath = path.join(projPath, file);
      const sessionId = path.basename(file, ".jsonl");
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;

      // Skip if already indexed with same file size (no changes)
      const existing = existingConv.get(sessionId) as { session_id: string; file_size: number } | undefined;
      if (existing && existing.file_size === fileSize) {
        skipped++;
        continue;
      }

      const { title, messages, startedAt } = await parseConversationFile(filePath);
      const userCount = messages.filter((m) => m.role === "user").length;
      const assistantCount = messages.filter((m) => m.role === "assistant").length;

      const txn = db.transaction(() => {
        // Clear old messages if re-indexing
        deleteMessages.run(sessionId);

        insertConv.run(
          sessionId,
          projectId,
          title,
          startedAt ?? new Date(stat.mtimeMs).toISOString(),
          messages.length,
          userCount,
          assistantCount,
          filePath,
          fileSize,
          new Date().toISOString()
        );

        for (const msg of messages) {
          insertMsg.run(sessionId, msg.role, msg.text, msg.seq, msg.timestamp ?? null);
        }
      });

      txn();
      indexed++;
    }
  }

  return { indexed, skipped };
}

/** Get raw JSONL content for a conversation (the actual file) */
export function getRawConversation(db: Database.Database, sessionId: string): string | null {
  const row = db.prepare(`SELECT file_path FROM conversations WHERE session_id = ?`).get(sessionId) as
    | { file_path: string }
    | undefined;
  if (!row) return null;

  try {
    return fs.readFileSync(row.file_path, "utf-8");
  } catch {
    return null;
  }
}
