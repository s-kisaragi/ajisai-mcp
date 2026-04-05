import fs from "node:fs";
import path from "node:path";
import type { ArchiveStore } from "./types.js";

/** Local filesystem archive — stores files in a local directory */
export class LocalArchiveStore implements ArchiveStore {
  constructor(private baseDir: string) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  private resolve(key: string): string {
    return path.join(this.baseDir, key);
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    const filePath = this.resolve(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data);
  }

  async get(key: string): Promise<string | null> {
    const filePath = this.resolve(key);
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    return fs.existsSync(this.resolve(key));
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.resolve(prefix);
    if (!fs.existsSync(dir)) return [];

    const results: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const rel = path.join(d, entry.name);
        if (entry.isDirectory()) walk(rel);
        else results.push(path.relative(this.baseDir, rel));
      }
    };
    walk(dir);
    return results;
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolve(key);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ok
    }
  }
}
