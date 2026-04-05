import fs from "node:fs";
import path from "node:path";

/** Parsed Claude Code memory file */
export interface ParsedMemoryFile {
  name: string;
  description: string;
  type: string;
  content: string;
  filePath: string;
  projectId: string;
}

/** Parse frontmatter from a Claude Code memory markdown file */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      meta[key] = value;
    }
  }
  return { meta, body: match[2].trim() };
}

/** Extract project ID from Claude Code's directory path.
 *  The dir name encodes the full path with "-" as separator.
 *  We reconstruct the original path and take the last directory name.
 *  e.g. "-Users-satsuki-d-Sirius" → "Sirius"
 *  e.g. "-Users-satsuki-d-ajisai-mcp" → "ajisai-mcp"
 */
function extractProjectId(dirName: string): string {
  // Reconstruct the original absolute path
  const reconstructed = dirName.replace(/^-/, "/").replace(/-/g, "/");
  // Check if this path exists on disk to find the correct split point
  // Walk from the end to find the longest existing parent directory
  const segments = reconstructed.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 1; i--) {
    const parentPath = "/" + segments.slice(0, i).join("/");
    try {
      if (fs.statSync(parentPath).isDirectory()) {
        // Everything after this parent is the project name
        return segments.slice(i).join("-");
      }
    } catch {
      continue;
    }
  }
  // Fallback: last segment
  return segments[segments.length - 1] || dirName;
}

/** Scan Claude Code project memory directories for all memory files */
export function scanClaudeCodeMemories(claudeDir?: string): ParsedMemoryFile[] {
  const baseDir = claudeDir ?? path.join(process.env.HOME ?? "", ".claude", "projects");
  const results: ParsedMemoryFile[] = [];

  if (!fs.existsSync(baseDir)) return results;

  const projectDirs = fs.readdirSync(baseDir);
  for (const projDir of projectDirs) {
    const memoryDir = path.join(baseDir, projDir, "memory");
    if (!fs.existsSync(memoryDir) || !fs.statSync(memoryDir).isDirectory()) continue;

    const projectId = extractProjectId(projDir);
    const files = fs.readdirSync(memoryDir);

    for (const file of files) {
      if (file === "MEMORY.md" || !file.endsWith(".md")) continue;

      const filePath = path.join(memoryDir, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const { meta, body } = parseFrontmatter(raw);

      if (!body) continue;

      results.push({
        name: meta.name || path.basename(file, ".md"),
        description: meta.description || "",
        type: meta.type || "knowledge",
        content: body,
        filePath,
        projectId,
      });
    }
  }

  return results;
}
