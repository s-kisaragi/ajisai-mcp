import { SqliteMemoryStore } from "./store/sqlite-store.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DB_PATH = path.join(os.tmpdir(), `ajisai-test-${Date.now()}.db`);
const store = new SqliteMemoryStore(DB_PATH);

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

async function main() {
  console.log("\n=== ajisai-mcp store tests ===\n");

  // --- CREATE ---
  console.log("[create]");
  const m1 = await store.create({
    type: "user",
    scope: "global",
    name: "user_role",
    description: "User is a senior iOS/TS engineer",
    content: "# User Profile\n\nSenior engineer focused on iOS and TypeScript.",
    tags: ["profile"],
  });
  assert(!!m1.id, "memory has ID");
  assert(m1.type === "user", "type = user");
  assert(m1.scope === "global", "scope = global");
  assert(m1.tags[0] === "profile", "tags preserved");
  assert(!!m1.createdAt, "has createdAt");

  const m2 = await store.create({
    type: "project",
    scope: "project",
    name: "ajisai-mcp overview",
    description: "MCP server project overview",
    content: "Building an MCP server for memory persistence.",
    projectId: "ajisai-mcp",
    tags: ["mcp", "architecture"],
  });
  assert(m2.projectId === "ajisai-mcp", "project scoped memory");

  const m3 = await store.create({
    type: "feedback",
    scope: "global",
    name: "terse responses",
    description: "User wants short responses",
    content: "Keep responses short. No trailing summaries.",
    tags: ["style"],
  });

  // --- GET ---
  console.log("[get]");
  const fetched = await store.get(m1.id);
  assert(fetched !== null, "memory found by ID");
  assert(fetched!.name === "user_role", "correct name");

  const notFound = await store.get("nonexistent");
  assert(notFound === null, "returns null for missing ID");

  // --- UPDATE ---
  console.log("[update]");
  const updated = await store.update(m1.id, {
    content: "# User Profile\n\nSenior engineer. Expert in iOS, TypeScript, and MCP.",
    tags: ["profile", "updated"],
  });
  assert(updated.content.includes("MCP"), "content updated");
  assert(updated.tags.length === 2, "tags updated");
  assert(updated.updatedAt > m1.updatedAt, "updatedAt advanced");

  // --- HISTORY (version tracking) ---
  console.log("[history]");
  const versions = await store.history(m1.id);
  assert(versions.length === 2, `2 versions recorded (got ${versions.length})`);
  assert(versions[0].version === 1, "v1 exists");
  assert(versions[1].version === 2, "v2 exists");
  assert(versions[1].diff.length > 0, "v2 has diff content");
  assert(versions[1].changedBy === "claude", "changedBy = claude");

  // --- LIST ---
  console.log("[list]");
  const all = await store.list({});
  assert(all.length === 3, `3 memories total (got ${all.length})`);

  const usersOnly = await store.list({ type: "user" });
  assert(usersOnly.length === 1, "filter by type works");

  const projectScoped = await store.list({ projectId: "ajisai-mcp" });
  assert(projectScoped.length >= 1, "filter by projectId works");
  // Should include global memories too
  const hasGlobal = projectScoped.some((m) => m.scope === "global");
  assert(hasGlobal, "projectId filter includes global memories");

  const tagFiltered = await store.list({ tags: ["architecture"] });
  assert(tagFiltered.length === 1, "filter by tags works");

  // --- SEARCH (FTS5) ---
  console.log("[search]");
  const searchResults = await store.search({ query: "iOS" });
  assert(searchResults.length >= 1, "FTS finds 'iOS'");
  assert(searchResults[0].name === "user_role", "correct result for 'iOS'");

  const searchMcp = await store.search({ query: "MCP" });
  assert(searchMcp.length >= 1, "FTS finds 'MCP'");

  const searchScoped = await store.search({ query: "MCP", type: "project" });
  assert(searchScoped.length === 1, "FTS + type filter works");

  const searchEmpty = await store.search({ query: "zzzznonexistent" });
  assert(searchEmpty.length === 0, "no results for gibberish");

  // --- DELETE ---
  console.log("[delete]");
  await store.delete(m3.id);
  const afterDelete = await store.get(m3.id);
  assert(afterDelete === null, "memory deleted");

  const remaining = await store.list({});
  assert(remaining.length === 2, `2 memories remaining (got ${remaining.length})`);

  // --- Multiple updates (version chain) ---
  console.log("[version chain]");
  await store.update(m1.id, { content: "Version 3 content." });
  await store.update(m1.id, { content: "Version 4 content." });
  const fullHistory = await store.history(m1.id);
  assert(fullHistory.length === 4, `4 versions total (got ${fullHistory.length})`);
  assert(fullHistory[3].version === 4, "v4 recorded");

  // --- Shared scope ---
  console.log("[shared scope]");
  const shared = await store.create({
    type: "knowledge",
    scope: "shared",
    name: "TS patterns",
    description: "Common TypeScript patterns",
    content: "## Patterns\n\n- Builder pattern\n- Repository pattern",
    sharedProjectIds: ["ajisai-mcp", "other-project"],
  });
  assert(shared.scope === "shared", "shared scope created");

  // --- Cleanup ---
  store.close();
  fs.unlinkSync(DB_PATH);
  try { fs.unlinkSync(DB_PATH + "-wal"); } catch { /* ok */ }
  try { fs.unlinkSync(DB_PATH + "-shm"); } catch { /* ok */ }

  // --- Summary ---
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});
