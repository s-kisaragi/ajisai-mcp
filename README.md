# ajisai-mcp

Persistent memory MCP server for Claude. Store, search, and sync memories and conversations across Claude Code, Claude Desktop, Claude.ai, and Claude iOS.

```
Claude Code     ─┐
Claude Desktop  ─┤→ ajisai-mcp → SQLite + S3
Claude.ai (web) ─┤     ↑ OAuth 2.0 + Streamable HTTP
Claude iOS      ─┘
```

## Features

- **Memory CRUD** — Create, read, update, delete with type/scope/tags and full-text search (FTS5)
- **Version history** — Every content change is recorded as a unified diff
- **Conversation archive** — Index and search Claude Code + Claude.ai conversations, archive raw data to S3
- **Cross-platform** — stdio for local clients, Streamable HTTP for remote (iOS/web)
- **OAuth 2.0** — Authorization Code + PKCE for secure remote access
- **S3 backup** — Archive conversations and subagent logs to any S3-compatible storage
- **Project unification** — Link scattered project directories to a single logical project via file path fingerprinting
- **Claude.ai import** — Import conversations, memories, and project configs from Claude.ai export

## Quick Start

```bash
git clone https://github.com/s-kisaragi/ajisai-mcp.git
cd ajisai-mcp
npm install
npm run build
```

### Claude Code

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "ajisai-mcp": {
      "command": "node",
      "args": ["/path/to/ajisai-mcp/dist/index.js"],
      "env": {
        "AJISAI_S3_BUCKET": "your-bucket",
        "AJISAI_S3_REGION": "ap-northeast-1",
        "AWS_ACCESS_KEY_ID": "...",
        "AWS_SECRET_ACCESS_KEY": "..."
      }
    }
  }
}
```

S3 env vars are optional — without them, archives are stored locally in `~/.ajisai/archives/`.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ajisai-mcp": {
      "command": "/path/to/node",
      "args": ["/path/to/ajisai-mcp/dist/index.js"]
    }
  }
}
```

> **Note:** Claude Desktop doesn't inherit shell PATH. Use the full path to `node` (run `which node` to find it).

### Remote Access (Claude.ai / iOS)

Start the HTTP server with OAuth:

```bash
# Start tunnel
cloudflared tunnel --url http://localhost:3000 &

# Start server (set AJISAI_BASE_URL to your tunnel URL)
AJISAI_TRANSPORT=http \
AJISAI_AUTH_PASSWORD="your-password" \
AJISAI_BASE_URL="https://your-tunnel.trycloudflare.com" \
node dist/index.js
```

Or use the helper script:

```bash
AJISAI_AUTH_PASSWORD="your-password" ./start-remote.sh
```

The script outputs the Server URL, Client ID, and Client Secret to enter in Claude.ai (Settings → Integrations → Add).

## Tools

### Memory

| Tool | Description |
|---|---|
| `memory_create` | Create a memory (type, scope, tags, content) |
| `memory_get` | Get by ID |
| `memory_update` | Update with automatic version history |
| `memory_delete` | Delete |
| `memory_search` | Full-text search (FTS5) |
| `memory_list` | List with filters (type, scope, project, tags) |
| `memory_history` | View version history |
| `memory_restore` | Restore to a previous version |
| `memory_import` | Import from Claude Code memory files |

### Conversations

| Tool | Description |
|---|---|
| `conversation_index` | Scan and index Claude Code JSONL files |
| `conversation_list` | List indexed conversations |
| `conversation_get` | Get messages or raw data |
| `conversation_search` | Full-text search across conversations |
| `conversation_archive` | Archive to S3 (includes subagent logs) |
| `conversation_fetch` | Fetch raw data from archive |

### Import

| Tool | Description |
|---|---|
| `import_claude_ai` | Import Claude.ai export (conversations + memories + projects) |

### Project Unification

| Tool | Description |
|---|---|
| `project_unify` | Auto-detect scattered directories for the same project |
| `project_link` | Manually link a path to a logical project |
| `project_unlink` | Remove a link |
| `project_list` | List unified projects |

## Architecture

```
~/.ajisai/
├── ajisai.db           # SQLite (memories, conversation index, projects)
└── archives/           # Local archive (when S3 is not configured)

s3://bucket/prefix/
├── conversations/
│   ├── claude-code/    # JSONL files
│   └── claude-ai/      # JSON files
└── metadata/           # sessions-index.json backups
```

### Memory Scoping

```
global/     ← visible to all projects
project/    ← visible to one project
shared/     ← visible to multiple projects
```

### Memory Types

| Type | Description |
|---|---|
| `user` | User profile, preferences, knowledge |
| `feedback` | Behavioral guidance (do this, don't do that) |
| `project` | Project-specific context |
| `reference` | Pointers to external resources |
| `knowledge` | General knowledge entries |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AJISAI_DATA_DIR` | `~/.ajisai` | Database and local archive location |
| `AJISAI_TRANSPORT` | `stdio` | `stdio` or `http` |
| `AJISAI_PORT` | `3000` | HTTP server port |
| `AJISAI_AUTH_PASSWORD` | — | OAuth password (enables OAuth endpoints) |
| `AJISAI_AUTH_TOKEN` | — | Static Bearer token (alternative to OAuth) |
| `AJISAI_BASE_URL` | `http://localhost:3000` | OAuth issuer URL |
| `AJISAI_S3_BUCKET` | — | S3 bucket (omit for local archive) |
| `AJISAI_S3_REGION` | `auto` | S3 region |
| `AJISAI_S3_PREFIX` | — | S3 key prefix |
| `AJISAI_S3_ENDPOINT` | — | Custom S3 endpoint (R2, MinIO) |
| `AWS_ACCESS_KEY_ID` | — | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | — | AWS credentials |

## License

MIT
