/** Source of conversation data */
export type ConversationSource = "claude-code" | "claude-web" | "claude-ios";

/** Metadata for an archived conversation file */
export interface ArchiveEntry {
  /** Original session ID */
  sessionId: string;
  /** Source application */
  source: ConversationSource;
  /** Project the conversation belongs to */
  projectId: string;
  /** Key/path in the archive storage */
  archiveKey: string;
  /** Size in bytes */
  size: number;
  /** When the file was archived */
  archivedAt: string;
}

/** Abstract archive storage — swap between local, S3, etc. */
export interface ArchiveStore {
  /** Store a file in the archive */
  put(key: string, data: Buffer | string): Promise<void>;
  /** Retrieve a file from the archive */
  get(key: string): Promise<string | null>;
  /** Check if a file exists */
  exists(key: string): Promise<boolean>;
  /** List keys matching a prefix */
  list(prefix: string): Promise<string[]>;
  /** Delete a file */
  delete(key: string): Promise<void>;
}
