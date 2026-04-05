import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemoryStore } from "../types.js";
import { scanClaudeCodeMemories } from "../import.js";

export function registerMemoryTools(s: McpServer, store: MemoryStore) {
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

  s.tool(
    "memory_get",
    "Get a memory by its ID",
    { id: z.string().describe("Memory ID (ULID)") },
    async ({ id }) => {
      const memory = await store.get(id);
      if (!memory) {
        return { content: [{ type: "text" as const, text: `Memory not found: ${id}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(memory, null, 2) }] };
    }
  );

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

  s.tool(
    "memory_delete",
    "Delete a memory by ID",
    { id: z.string().describe("Memory ID to delete") },
    async ({ id }) => {
      await store.delete(id);
      return { content: [{ type: "text" as const, text: `Deleted: ${id}` }] };
    }
  );

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

  s.tool(
    "memory_history",
    "Get version history of a specific memory",
    { id: z.string().describe("Memory ID") },
    async ({ id }) => {
      const versions = await store.history(id);
      return { content: [{ type: "text" as const, text: JSON.stringify(versions, null, 2) }] };
    }
  );

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

  s.tool(
    "memory_import",
    "Import memories from Claude Code's local memory files (~/.claude/projects/*/memory/).",
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
          const summary = files.map((f: { type: string; name: string; projectId: string; filePath: string }) =>
            `[${f.type}] ${f.name} (project: ${f.projectId}) — ${f.filePath}`
          );
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
}
