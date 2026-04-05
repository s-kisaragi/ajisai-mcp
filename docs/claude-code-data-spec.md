# Claude Code データ保存仕様書

> ajisai-mcp 設計のための基礎資料
> 作成日: 2026-04-04
> Sources: Anthropic公式ドキュメント, ローカルファイル実地調査

---

## 1. データの保存場所: ローカル vs クラウド

### ローカル保存（完全ローカル、同期なし）

| データ | 保存先 | 形式 |
|---|---|---|
| 会話ログ | `~/.claude/projects/{PROJECT}/{SESSION}.jsonl` | JSONL |
| プロンプト履歴 | `~/.claude/history.jsonl` | JSONL |
| Auto Memory | `~/.claude/projects/{PROJECT}/memory/` | Markdown + frontmatter |
| CLAUDE.md | `~/.claude/CLAUDE.md`, プロジェクトルート | Markdown |
| 設定 | `~/.claude/settings.json` | JSON |
| システム状態 | `~/.claude.json` | JSON (手動編集不可) |
| ファイル変更履歴 | `~/.claude/file-history/{SESSION}/{HASH}@v{N}` | Plain text |
| セッションメタ | `~/.claude/sessions/{PID}.json` | JSON |
| シェルスナップショット | `~/.claude/shell-snapshots/` | Shell script |
| TODO/Plans | `~/.claude/todos/`, `~/.claude/plans/` | JSON |
| 統計キャッシュ | `~/.claude/stats-cache.json` | JSON |
| デバッグログ | `~/.claude/debug/` | Text |
| MCP設定 | `~/.claude/.mcp.json` | JSON |
| プラグイン | `~/.claude/plugins/` | Mixed |
| スキル | `~/.claude/skills/` | Markdown |
| バックアップ | `~/.claude/backups/` | JSON |
| IDE連携 | `~/.claude/ide/{PID}.lock` | JSON |

**公式明言: "Auto memory is machine-local. Files are not shared across machines or cloud environments."**

### クラウド送信（Anthropic API）

| データ | 送信先 | 暗号化 | 保持期間 |
|---|---|---|---|
| プロンプト + モデル出力 | Anthropic API | TLS (in transit) | Consumer: 30日 or 5年 / Commercial: 30日 or 0日(ZDR) |
| テレメトリ (Statsig) | Statsig | AES-256 (at rest) | - |
| エラーログ (Sentry) | Sentry | AES-256 (at rest) | - |
| /feedback 送信時 | Anthropic | TLS | 5年 |

**注意: テレメトリにコードやファイルパスは含まれない**

### オプトアウト

```bash
DISABLE_TELEMETRY=1                          # Statsig無効化
DISABLE_ERROR_REPORTING=1                    # Sentry無効化
DISABLE_FEEDBACK_COMMAND=1                   # /feedback無効化
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1   # 上記すべて一括
```

---

## 2. ディレクトリ構造と容量

```
~/.claude/                          # 合計 ~135MB (実測値)
├── CLAUDE.md                       # グローバル system prompt (8KB)
├── .mcp.json                       # MCP サーバー設定
├── settings.json                   # ユーザー設定
├── history.jsonl                   # 全プロンプト履歴 (56KB, 226行)
├── stats-cache.json                # 使用統計 (12KB)
├── mcp-needs-auth-cache.json       # MCP認証状態
│
├── projects/                       # プロジェクト別データ (99MB, 28プロジェクト)
│   └── -{encoded-path}/
│       ├── {session-uuid}.jsonl    # 会話ログ (422ファイル)
│       ├── {session-uuid}/         # セッション添付データ
│       └── memory/
│           ├── MEMORY.md           # メモリインデックス
│           └── *.md                # トピック別メモリ (frontmatter付)
│
├── sessions/                       # アクティブセッション (3ファイル)
│   └── {pid}.json
│
├── file-history/                   # ファイル変更履歴 (4.8MB, 1,154ファイル)
│   └── {session-uuid}/
│       └── {hash}@v{version}
│
├── shell-snapshots/                # シェル環境スナップショット (3.6MB, 350ファイル)
│   └── snapshot-{shell}-{ts}-{rand}.sh
│
├── todos/                          # タスクリスト (3.7MB, 938ファイル)
│   └── {uuid}.json
│
├── plugins/                        # プラグイン (17MB)
│   ├── repos/
│   ├── cache/
│   └── installed_plugins.json
│
├── skills/                         # スキル定義 (400KB)
│   └── {skill-name}/SKILL.md
│
├── backups/                        # 状態バックアップ (380KB, 5ファイル)
│   └── .claude.json.backup.{ts}
│
├── telemetry/                      # テレメトリ (900KB)
│   └── 1p_failed_events.*.json
│
├── cache/                          # キャッシュ (116KB)
├── debug/                          # デバッグログ (44KB)
├── ide/                            # IDE連携ロック
├── plans/                          # 計画文書 (空)
├── session-env/                    # セッション環境変数 (空)
├── paste-cache/                    # クリップボード (空)
└── statsig/                        # Feature flags (112KB)
```

---

## 3. 会話ログ JSONL スキーマ

### ファイル: `~/.claude/projects/{PROJECT}/{SESSION}.jsonl`

1行1レコード。以下のレコードタイプが存在する:

### 3.1 user レコード

```jsonc
{
  "type": "user",
  "uuid": "msg-uuid",
  "parentUuid": null,              // 会話チェーン (nullなら最初の発言)
  "isSidechain": false,
  "promptId": "prompt-uuid",
  "sessionId": "session-uuid",
  "timestamp": "2026-04-02T13:30:49.161Z",
  "cwd": "/Users/satsuki/d/ajisai-mcp",
  "gitBranch": "main",
  "permissionMode": "acceptEdits",
  "userType": "external",
  "entrypoint": "claude-vscode",   // "cli" | "claude-vscode" | "claude-jetbrains"
  "version": "2.1.87",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "ユーザーの入力" },
      { "type": "tool_result", "tool_use_id": "...", "content": "..." }  // ツール結果
    ]
  }
}
```

### 3.2 assistant レコード

```jsonc
{
  "type": "assistant",
  "uuid": "msg-uuid",
  "parentUuid": "parent-msg-uuid",
  "isSidechain": false,
  "requestId": "req_...",
  "timestamp": "2026-04-02T13:31:27.235Z",
  "userType": "external",
  "entrypoint": "claude-vscode",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_...",
    "type": "message",
    "role": "assistant",
    "stop_reason": "end_turn",     // "end_turn" | "tool_use" | null
    "content": [
      { "type": "thinking", "thinking": "内部思考..." },
      { "type": "text", "text": "応答テキスト" },
      { "type": "tool_use", "id": "toolu_...", "name": "Write", "input": { ... } }
    ],
    "usage": {
      "input_tokens": 1,
      "cache_creation_input_tokens": 96,
      "cache_read_input_tokens": 41525,
      "output_tokens": 2
    }
  }
}
```

### 3.3 その他のレコードタイプ

| type | 用途 | 主なフィールド |
|---|---|---|
| `queue-operation` | 内部キュー制御 | `operation` ("enqueue"/"dequeue"), `timestamp`, `sessionId` |
| `ai-title` | 自動生成タイトル | `aiTitle`, `sessionId` |
| `last-prompt` | 最後のユーザー入力 | `lastPrompt`, `sessionId` |
| `file-history-snapshot` | ファイル変更スナップショット | `messageId`, `snapshot.trackedFileBackups` |
| `attachment` | ツール定義の差分 | `attachment.type`, `addedNames`, `addedLines` |

### 3.4 レコードタイプ分布 (実測: 533メッセージのセッション)

| type | 件数 |
|---|---|
| assistant | 236 |
| user | 163 |
| file-history-snapshot | 75 |
| queue-operation | 52 |
| last-prompt | 3 |
| attachment | 3 |
| ai-title | 1 |

---

## 4. Auto Memory フォーマット

### ファイル: `~/.claude/projects/{PROJECT}/memory/*.md`

```markdown
---
name: メモリ名
description: 一行説明（関連性判定に使用）
type: user | feedback | project | reference
---

メモリ本体（Markdown）

**Why:** 理由
**How to apply:** 適用方法
```

### MEMORY.md (インデックス)

```markdown
- [Title](file.md) — 一行フック（150文字以内）
```

- 200行を超えるとトランケートされる
- フロントマターなし
- メモリ本体は書かない（ポインタのみ）

---

## 5. history.jsonl スキーマ

### ファイル: `~/.claude/history.jsonl`

```jsonc
{
  "display": "ユーザーの入力テキスト",
  "pastedContents": {},            // ペーストされた内容のスニペット
  "timestamp": 1759056982410,      // Unix ms
  "project": "/Users/satsuki/d/ajisai-mcp"
}
```

---

## 6. セッションメタデータ

### ファイル: `~/.claude/sessions/{pid}.json`

```jsonc
{
  "pid": 24616,
  "sessionId": "session-uuid",
  "cwd": "/Users/satsuki/d/ajisai-mcp",
  "startedAt": 1775276077464,      // Unix ms
  "kind": "interactive",           // "interactive" | "headless"
  "entrypoint": "claude-vscode"
}
```

---

## 7. 統計キャッシュ

### ファイル: `~/.claude/stats-cache.json`

```jsonc
{
  "version": 2,
  "lastComputedDate": "2026-02-16",
  "totalSessions": 77,
  "totalMessages": 34444,
  "dailyActivity": [
    { "date": "2025-11-30", "messageCount": 1861, "sessionCount": 1, "toolCallCount": 550 }
  ],
  "dailyModelTokens": [
    { "date": "2025-11-30", "tokensByModel": { "claude-opus-4-5-20251101": 215151 } }
  ],
  "modelUsage": {
    "claude-opus-4-5-20251101": {
      "inputTokens": 774185,
      "outputTokens": 1418951,
      "cacheReadInputTokens": 1178536493,
      "cacheCreationInputTokens": 78494687
    }
  },
  "hourCounts": { "13": 5, "16": 7 }
}
```

---

## 8. ajisai-mcp にとっての重要ポイント

### アーカイブ対象の優先度

| 優先度 | データ | サイズ | 理由 |
|---|---|---|---|
| **P0** | 会話ログ (.jsonl) | 99MB | 最も価値が高い。記憶抽出の源泉 |
| **P0** | Auto Memory | <1MB | 既存の構造化知識。memory_import済み |
| **P1** | ファイル変更履歴 | 4.8MB | コード変更の追跡に有用 |
| **P1** | history.jsonl | 56KB | 全セッション横断のプロンプト索引 |
| **P2** | 統計キャッシュ | 12KB | 使用パターン分析 |
| **P2** | シェルスナップショット | 3.6MB | 環境再現に有用 |
| **P3** | TODO/Plans | 3.7MB | ほぼ空のレコードが多い |
| **P3** | デバッグログ | 44KB | トラブルシュート用 |

### Claude (web/iOS) のデータについて

- web/iOS版の会話データはAnthropicのサーバーに保存される
- ローカルファイルとしてはアクセス不可
- 取得方法: claude.aiのエクスポート機能 (Settings → Export Data)
- エクスポート形式: JSON (conversations.json)
- **ajisai-mcpで取り込むには、手動エクスポート → import ツールの拡張が必要**

### データの寿命

- ローカル会話ログ: **無期限**（手動削除まで保持）
- Auto Memory: **無期限**（手動削除まで保持）
- 会話履歴の無効化/インコグニートモード: **存在しない** (GitHub Issue #9296, #9044 は closed)
- つまり: **データは常にそこにある。ajisai-mcpで活用できる**
