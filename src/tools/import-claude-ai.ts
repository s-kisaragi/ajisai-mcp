import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SqliteMemoryStore } from "../store/sqlite-store.js";
import type { ArchiveStore } from "../archive/types.js";
import { importClaudeAiConversations, importClaudeAiMemories, importClaudeAiProjects } from "../import-claude-ai.js";

export function registerImportClaudeAiTools(
  s: McpServer,
  store: SqliteMemoryStore,
  archive: ArchiveStore
) {
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

        let projects: Array<{ uuid: string; name: string; is_starter_project: boolean }> = [];
        if (!skipProjects) {
          const projResult = await importClaudeAiProjects(store, dir);
          projects = projResult.projects;
          results.push(`✓ Projects: ${projResult.imported} imported`);
        } else {
          const projFile = path.join(dir, "projects.json");
          if (fs.existsSync(projFile)) {
            projects = JSON.parse(fs.readFileSync(projFile, "utf-8"));
          }
        }

        if (!skipMemories) {
          const memResult = await importClaudeAiMemories(store, dir, projects as never);
          results.push(`✓ Memories: ${memResult.imported} imported`);
        }

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
}
