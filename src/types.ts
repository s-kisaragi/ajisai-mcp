/** Memory type categories compatible with Claude Code memory system */
export type MemoryType = "user" | "feedback" | "project" | "reference" | "knowledge";

/** Scope determines visibility of a memory */
export type MemoryScope = "global" | "project" | "shared";

/** Who made the change */
export type ChangedBy = "claude" | "user" | "system";

/** Core memory entity */
export interface Memory {
  id: string;
  type: MemoryType;
  scope: MemoryScope;
  name: string;
  description: string;
  content: string;
  tags: string[];
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating a new memory */
export interface MemoryCreateInput {
  type: MemoryType;
  scope?: MemoryScope;
  name: string;
  description: string;
  content: string;
  tags?: string[];
  projectId?: string;
  sharedProjectIds?: string[];
}

/** Input for updating an existing memory */
export interface MemoryUpdateInput {
  name?: string;
  description?: string;
  content?: string;
  type?: MemoryType;
  scope?: MemoryScope;
  tags?: string[];
  projectId?: string;
}

/** Version history entry */
export interface MemoryVersion {
  id: string;
  memoryId: string;
  version: number;
  diff: string;
  changedBy: ChangedBy;
  createdAt: string;
}

/** Search query parameters */
export interface SearchQuery {
  query: string;
  type?: MemoryType;
  scope?: MemoryScope;
  projectId?: string;
  tags?: string[];
  limit?: number;
}

/** List filter parameters */
export interface ListFilter {
  type?: MemoryType;
  scope?: MemoryScope;
  projectId?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

/** Abstract store interface — swap implementations without touching app logic */
export interface MemoryStore {
  create(input: MemoryCreateInput): Promise<Memory>;
  get(id: string): Promise<Memory | null>;
  update(id: string, patch: MemoryUpdateInput, changedBy?: ChangedBy): Promise<Memory>;
  delete(id: string): Promise<void>;
  search(query: SearchQuery): Promise<Memory[]>;
  list(filter: ListFilter): Promise<Memory[]>;
  history(id: string): Promise<MemoryVersion[]>;
  restore(id: string, version: number): Promise<Memory>;
  close(): void;
}
