import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SqliteMemoryStore } from "../store/sqlite-store.js";
import { indexConversations } from "../conversations.js";
import { detectUnifyCandidates, linkProject, unlinkProject, listProjects, applyUnification } from "../projects.js";

export function registerProjectTools(s: McpServer, store: SqliteMemoryStore) {
  s.tool(
    "project_unify",
    "Detect scattered project directories that likely belong to the same repository, using file path fingerprinting and timeline analysis.",
    {
      threshold: z.number().optional().default(0.2).describe("Jaccard similarity threshold (0-1, default 0.2)"),
      apply: z.boolean().optional().default(false).describe("If true, automatically apply all detected unifications"),
    },
    async ({ threshold, apply }) => {
      try {
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

  s.tool(
    "project_link",
    "Manually link a directory path to a logical project (repository).",
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

  s.tool(
    "project_unlink",
    "Remove a directory path from its logical project association.",
    { path: z.string().describe("Directory path to unlink") },
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

  s.tool(
    "project_list",
    "List all logical projects (repositories) with their directory aliases.",
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
}
