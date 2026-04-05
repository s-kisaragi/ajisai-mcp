import type Database from "better-sqlite3";
import { ulid } from "ulid";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// --- Types ---

interface Repository {
  id: string;
  name: string;
  remoteUrl: string | null;
  createdAt: string;
}

interface ProjectAlias {
  path: string;
  repoId: string;
  firstSeen: string;
  lastSeen: string;
  source: string;
}

interface UnifyCandidate {
  paths: string[];
  similarity: number;
  commonFiles: string[];
  timelineConsistent: boolean;
  suggestedName: string;
  existingRepoId?: string;
}

// --- Fingerprint extraction ---

/** Extract relative file paths from a conversation JSONL for fingerprinting */
async function extractFingerprint(filePath: string, cwd: string): Promise<Set<string>> {
  const paths = new Set<string>();

  let input: fs.ReadStream;
  try {
    input = fs.createReadStream(filePath);
  } catch {
    return paths;
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type !== "assistant") continue;
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block?.type !== "tool_use") continue;
        const inp = block.input;
        if (!inp) continue;

        // Extract file_path from tool inputs (Read, Write, Edit, Glob, etc.)
        const fp: string | undefined = inp.file_path ?? inp.path;
        if (fp && typeof fp === "string" && fp.startsWith(cwd + "/")) {
          const rel = fp.slice(cwd.length + 1);
          // Filter out noise: temp files, node_modules, dist, etc.
          if (!rel.startsWith("node_modules/") &&
              !rel.startsWith("dist/") &&
              !rel.startsWith(".git/") &&
              !rel.startsWith("/tmp/") &&
              rel.length < 200) {
            paths.add(rel);
          }
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  return paths;
}

/** Jaccard similarity between two sets */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Extract the last directory component as a suggested project name */
function suggestName(paths: string[]): string {
  const names = paths.map((p) => path.basename(p));
  // Most common name
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  let best = names[0];
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

// --- Core operations ---

/** Scan all conversations, build fingerprints, and detect unification candidates */
export async function detectUnifyCandidates(
  db: Database.Database,
  threshold: number = 0.2
): Promise<UnifyCandidate[]> {
  // Get all conversations grouped by their cwd
  const rows = db.prepare(`
    SELECT session_id, project_id, file_path FROM conversations ORDER BY started_at
  `).all() as Array<{ session_id: string; project_id: string; file_path: string }>;

  // Get cwds from conversation_messages
  const cwdMap = new Map<string, Set<string>>();
  const sessionTimes = new Map<string, { first: string; last: string }>();

  for (const row of rows) {
    const msgs = db.prepare(`
      SELECT timestamp FROM conversation_messages
      WHERE session_id = ? AND timestamp IS NOT NULL
      ORDER BY seq
    `).all(row.session_id) as Array<{ timestamp: string }>;

    if (msgs.length > 0) {
      sessionTimes.set(row.session_id, {
        first: msgs[0].timestamp,
        last: msgs[msgs.length - 1].timestamp,
      });
    }
  }

  // Extract cwds from the original JSONL files
  const cwdToSessions = new Map<string, string[]>();
  for (const row of rows) {
    // Read the first user record to get cwd
    let filePath = row.file_path;
    // If it's an archive key, try the original path
    if (!filePath.startsWith("/")) {
      // Can't read archived files for fingerprinting, skip
      continue;
    }

    try {
      const input = fs.createReadStream(filePath);
      const rl = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const line of rl) {
        const rec = JSON.parse(line);
        if (rec.type === "user" && rec.cwd) {
          const cwd = rec.cwd as string;
          if (!cwdToSessions.has(cwd)) cwdToSessions.set(cwd, []);
          cwdToSessions.get(cwd)!.push(row.session_id);
          if (!cwdMap.has(row.session_id)) cwdMap.set(row.session_id, new Set());
          cwdMap.get(row.session_id)!.add(cwd);
          break;
        }
      }
    } catch {
      continue;
    }
  }

  // Build fingerprints per cwd
  const cwdFingerprints = new Map<string, Set<string>>();
  for (const [cwd, sessionIds] of cwdToSessions) {
    const combined = new Set<string>();
    for (const sid of sessionIds) {
      const row = rows.find((r) => r.session_id === sid);
      if (!row || !row.file_path.startsWith("/")) continue;
      const fp = await extractFingerprint(row.file_path, cwd);
      for (const p of fp) combined.add(p);
    }
    cwdFingerprints.set(cwd, combined);
  }

  // Compare all pairs of cwds
  const cwds = Array.from(cwdFingerprints.keys());
  const merged = new Map<string, Set<string>>(); // cwd → group key

  for (let i = 0; i < cwds.length; i++) {
    for (let j = i + 1; j < cwds.length; j++) {
      const a = cwds[i];
      const b = cwds[j];
      const fpA = cwdFingerprints.get(a)!;
      const fpB = cwdFingerprints.get(b)!;

      // Skip if both have very few files (not enough signal)
      if (fpA.size < 3 && fpB.size < 3) continue;

      const sim = jaccard(fpA, fpB);
      if (sim >= threshold) {
        // Merge into same group
        const groupA = merged.get(a);
        const groupB = merged.get(b);

        if (!groupA && !groupB) {
          const group = new Set([a, b]);
          merged.set(a, group);
          merged.set(b, group);
        } else if (groupA && !groupB) {
          groupA.add(b);
          merged.set(b, groupA);
        } else if (!groupA && groupB) {
          groupB.add(a);
          merged.set(a, groupB);
        } else if (groupA && groupB && groupA !== groupB) {
          // Merge two groups
          for (const p of groupB) {
            groupA.add(p);
            merged.set(p, groupA);
          }
        }
      }
    }
  }

  // Build candidate list from groups
  const seen = new Set<Set<string>>();
  const candidates: UnifyCandidate[] = [];

  for (const group of merged.values()) {
    if (seen.has(group)) continue;
    seen.add(group);

    const paths = Array.from(group);
    if (paths.length < 2) continue;

    // Calculate overall similarity (average pairwise)
    let totalSim = 0;
    let pairs = 0;
    const allCommon = new Set<string>();

    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const fpA = cwdFingerprints.get(paths[i])!;
        const fpB = cwdFingerprints.get(paths[j])!;
        totalSim += jaccard(fpA, fpB);
        pairs++;
        for (const f of fpA) {
          if (fpB.has(f)) allCommon.add(f);
        }
      }
    }

    // Check timeline consistency
    const times = paths.map((p) => {
      const sessions = cwdToSessions.get(p) ?? [];
      const sessionTimeList = sessions
        .map((s) => sessionTimes.get(s))
        .filter(Boolean) as Array<{ first: string; last: string }>;
      return {
        path: p,
        first: sessionTimeList.reduce((min, t) => t.first < min ? t.first : min, "9999"),
        last: sessionTimeList.reduce((max, t) => t.last > max ? t.last : max, "0000"),
      };
    }).sort((a, b) => a.first.localeCompare(b.first));

    // Timeline is consistent if periods don't overlap significantly
    let timelineConsistent = true;
    for (let i = 0; i < times.length - 1; i++) {
      if (times[i].last > times[i + 1].first) {
        // Overlap exists — could still be the same project if moved mid-session
        // Allow some tolerance
        timelineConsistent = false;
      }
    }

    // Check if any of these paths already have a repo_id
    const existingAlias = db.prepare(
      `SELECT repo_id FROM project_aliases WHERE path IN (${paths.map(() => "?").join(",")})`
    ).get(...paths) as { repo_id: string } | undefined;

    candidates.push({
      paths,
      similarity: pairs > 0 ? totalSim / pairs : 0,
      commonFiles: Array.from(allCommon).slice(0, 20),
      timelineConsistent,
      suggestedName: suggestName(paths),
      existingRepoId: existingAlias?.repo_id,
    });
  }

  return candidates.sort((a, b) => b.similarity - a.similarity);
}

/** Link a path to a repository (create repo if needed) */
export function linkProject(
  db: Database.Database,
  projectPath: string,
  repoName: string,
  options?: { remoteUrl?: string; repoId?: string; source?: string }
): Repository {
  const now = new Date().toISOString();
  const source = options?.source ?? "manual";

  let repoId = options?.repoId;

  if (!repoId) {
    // Check if repo exists by name
    const existing = db.prepare(`SELECT id FROM repositories WHERE name = ?`).get(repoName) as
      | { id: string }
      | undefined;
    if (existing) {
      repoId = existing.id;
    } else {
      repoId = ulid();
      db.prepare(
        `INSERT INTO repositories (id, name, remote_url, created_at) VALUES (?, ?, ?, ?)`
      ).run(repoId, repoName, options?.remoteUrl ?? null, now);
    }
  }

  // Upsert alias
  const existingAlias = db.prepare(`SELECT path FROM project_aliases WHERE path = ?`).get(projectPath) as
    | { path: string }
    | undefined;

  if (existingAlias) {
    db.prepare(
      `UPDATE project_aliases SET repo_id = ?, last_seen = ?, source = ? WHERE path = ?`
    ).run(repoId, now, source, projectPath);
  } else {
    db.prepare(
      `INSERT INTO project_aliases (path, repo_id, first_seen, last_seen, source) VALUES (?, ?, ?, ?, ?)`
    ).run(projectPath, repoId, now, now, source);
  }

  return db.prepare(`SELECT * FROM repositories WHERE id = ?`).get(repoId) as Repository;
}

/** Unlink a path from its repository */
export function unlinkProject(db: Database.Database, projectPath: string): boolean {
  const result = db.prepare(`DELETE FROM project_aliases WHERE path = ?`).run(projectPath);
  return result.changes > 0;
}

/** List all repositories with their aliases */
export function listProjects(db: Database.Database): Array<Repository & { aliases: ProjectAlias[] }> {
  const repos = db.prepare(`SELECT * FROM repositories ORDER BY name`).all() as Array<{
    id: string;
    name: string;
    remote_url: string | null;
    created_at: string;
  }>;

  return repos.map((r) => {
    const aliases = db.prepare(
      `SELECT * FROM project_aliases WHERE repo_id = ? ORDER BY first_seen`
    ).all(r.id) as Array<{
      path: string;
      repo_id: string;
      first_seen: string;
      last_seen: string;
      source: string;
    }>;

    return {
      id: r.id,
      name: r.name,
      remoteUrl: r.remote_url,
      createdAt: r.created_at,
      aliases: aliases.map((a) => ({
        path: a.path,
        repoId: a.repo_id,
        firstSeen: a.first_seen,
        lastSeen: a.last_seen,
        source: a.source,
      })),
    };
  });
}

/** Apply unification: create repo + link all paths */
export function applyUnification(
  db: Database.Database,
  paths: string[],
  repoName: string,
  remoteUrl?: string
): Repository {
  const now = new Date().toISOString();
  const repoId = ulid();

  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO repositories (id, name, remote_url, created_at) VALUES (?, ?, ?, ?)`
    ).run(repoId, repoName, remoteUrl ?? null, now);

    const insert = db.prepare(
      `INSERT OR REPLACE INTO project_aliases (path, repo_id, first_seen, last_seen, source) VALUES (?, ?, ?, ?, 'auto')`
    );

    for (const p of paths) {
      insert.run(p, repoId, now, now);
    }
  });

  txn();

  return db.prepare(`SELECT * FROM repositories WHERE id = ?`).get(repoId) as Repository;
}
