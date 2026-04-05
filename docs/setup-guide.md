# ajisai-mcp セットアップガイド

## 概要

ajisai-mcp は Claude の記憶を永続化する MCP サーバー。  
Claude Code / Claude Desktop / Claude.ai (web) / Claude iOS の全プラットフォームから接続できる。

```
Claude iOS      ─┐
Claude.ai (web) ─┤→ OAuth 2.0 → cloudflared → ajisai-mcp (HTTP)
Claude Desktop  ─┤→ stdio (ローカル直接)
Claude Code     ─┘→ stdio (ローカル直接)
                                                    │
                                               SQLite + S3
```

---

## 1. インストール

```bash
git clone <repo-url> && cd ajisai-mcp
npm install
npm run build
npm link   # グローバルコマンド "ajisai-mcp" を登録
```

### 動作確認

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | ajisai-mcp
```

`protocolVersion` と `serverInfo` が返ればOK。

---

## 2. Claude Code 接続 (stdio)

`~/.claude/.mcp.json` に追加:

```json
{
  "mcpServers": {
    "ajisai-mcp": {
      "command": "ajisai-mcp",
      "args": [],
      "env": {
        "AJISAI_S3_BUCKET": "<your-bucket>",
        "AJISAI_S3_REGION": "ap-northeast-1",
        "AJISAI_S3_PREFIX": "ajisai",
        "AWS_ACCESS_KEY_ID": "<your-key>",
        "AWS_SECRET_ACCESS_KEY": "<your-secret>"
      }
    }
  }
}
```

> **Note:** `ajisai-mcp` コマンドが PATH にない場合は、node のフルパスで指定:
> ```json
> "command": "/path/to/node",
> "args": ["/path/to/ajisai-mcp/dist/index.js"]
> ```

S3 の env を省略するとローカルアーカイブモード (`~/.ajisai/archives/`) で動作する。

---

## 3. Claude Desktop 接続 (stdio)

`~/Library/Application Support/Claude/claude_desktop_config.json` に追加:

```json
{
  "mcpServers": {
    "ajisai-mcp": {
      "command": "/path/to/node",
      "args": ["/path/to/ajisai-mcp/dist/index.js"],
      "env": {
        "AJISAI_S3_BUCKET": "<your-bucket>",
        "AJISAI_S3_REGION": "ap-northeast-1",
        "AJISAI_S3_PREFIX": "ajisai",
        "AWS_ACCESS_KEY_ID": "<your-key>",
        "AWS_SECRET_ACCESS_KEY": "<your-secret>"
      }
    }
  }
}
```

> **重要:** Claude Desktop は mise/nvm 等の node を認識しない。  
> `which node` でフルパスを確認して `command` に指定すること。

設定後、Claude Desktop を再起動 (Cmd+Q → 再度開く)。

---

## 4. Claude.ai / Claude iOS 接続 (HTTP + OAuth + cloudflared)

リモート接続は 3 ステップ: サーバー起動 → トンネル → Claude.ai に登録。

### 4.1 cloudflared のインストール

```bash
brew install cloudflared
```

### 4.2 起動スクリプト

以下を `start-remote.sh` として保存しておくと便利:

```bash
#!/bin/bash

# --- 設定 ---
export AJISAI_TRANSPORT=http
export AJISAI_AUTH_PASSWORD="<your-password>"     # OAuth 認可用パスワード
export AJISAI_S3_BUCKET="<your-bucket>"
export AJISAI_S3_REGION="ap-northeast-1"
export AJISAI_S3_PREFIX="ajisai"
export AWS_ACCESS_KEY_ID="<your-key>"
export AWS_SECRET_ACCESS_KEY="<your-secret>"

# --- 1. cloudflared トンネルを先に起動してURLを取得 ---
cloudflared tunnel --url http://localhost:3000 > /tmp/cloudflared.log 2>&1 &
TUNNEL_PID=$!
echo "Waiting for tunnel..."
sleep 10

TUNNEL_URL=$(grep -o "https://.*trycloudflare.com" /tmp/cloudflared.log | head -1)
if [ -z "$TUNNEL_URL" ]; then
  echo "ERROR: Failed to get tunnel URL"
  kill $TUNNEL_PID 2>/dev/null
  exit 1
fi
echo "Tunnel: $TUNNEL_URL"

# --- 2. AJISAI_BASE_URL にトンネルURLを設定してサーバー起動 ---
export AJISAI_BASE_URL="$TUNNEL_URL"
node /path/to/ajisai-mcp/dist/index.js &
SERVER_PID=$!
sleep 2

# --- 3. Claude.ai 用のクライアントを事前登録 ---
echo ""
echo "=== Claude.ai 接続情報 ==="
echo "Server URL: $TUNNEL_URL/mcp"
echo ""

CLIENT=$(curl -s -X POST "$TUNNEL_URL/register" \
  -H "Content-Type: application/json" \
  -d "{\"redirect_uris\":[\"https://claude.ai/api/mcp/oauth/callback\"],\"client_name\":\"Claude.ai\"}")

CLIENT_ID=$(echo "$CLIENT" | python3 -c "import sys,json; print(json.load(sys.stdin)['client_id'])")
CLIENT_SECRET=$(echo "$CLIENT" | python3 -c "import sys,json; print(json.load(sys.stdin)['client_secret'])")

echo "Client ID:     $CLIENT_ID"
echo "Client Secret: $CLIENT_SECRET"
echo "Password:      $AJISAI_AUTH_PASSWORD"
echo ""
echo "Press Ctrl+C to stop."

# --- Cleanup on exit ---
trap "kill $SERVER_PID $TUNNEL_PID 2>/dev/null; echo 'Stopped.'" EXIT
wait
```

### 4.3 実行

```bash
chmod +x start-remote.sh
./start-remote.sh
```

出力例:

```
Tunnel: https://xxx-yyy-zzz.trycloudflare.com

=== Claude.ai 接続情報 ===
Server URL: https://xxx-yyy-zzz.trycloudflare.com/mcp
Client ID:     f2f12b88-...
Client Secret: SdeKdZj3u_...
Password:      your-password
```

### 4.4 Claude.ai での設定

1. **claude.ai** → **Settings** → **Integrations**
2. **Add Integration** をクリック
3. 以下を入力:
   - **Server URL:** `https://xxx-yyy-zzz.trycloudflare.com/mcp`
   - **Client ID:** 出力された値
   - **Client Secret:** 出力された値
4. OAuth 認可画面が開く → パスワードを入力
5. 接続完了 — ツール一覧が表示される

### 4.5 Claude iOS での設定

Claude iOS アプリ → Settings → MCP Servers → Add Server → 同じ情報を入力。

### 4.6 注意事項

- **cloudflared の一時URL は起動ごとに変わる。** 再起動したら Claude.ai の設定も更新が必要。
- **トークンは 7 日間有効。** 期限切れ後は再認証が求められる。
- **サーバーを止めるとリモート接続は切れる。** 常時稼働が必要なら VPS デプロイを検討。

---

## 5. 環境変数一覧

| 変数 | 必須 | デフォルト | 説明 |
|---|---|---|---|
| `AJISAI_DATA_DIR` | × | `~/.ajisai` | SQLite DB とローカルアーカイブの保存先 |
| `AJISAI_TRANSPORT` | × | `stdio` | `stdio` or `http` |
| `AJISAI_PORT` | × | `3000` | HTTP モード時のポート |
| `AJISAI_AUTH_PASSWORD` | × | — | OAuth 認可用パスワード (HTTP モード) |
| `AJISAI_AUTH_TOKEN` | × | — | 静的 Bearer トークン (HTTP モード、OAuth の代替) |
| `AJISAI_BASE_URL` | × | `http://localhost:3000` | OAuth の issuer URL (トンネル使用時はトンネルURL) |
| `AJISAI_S3_BUCKET` | × | — | S3 バケット名 (未設定でローカルアーカイブ) |
| `AJISAI_S3_REGION` | × | `auto` | S3 リージョン |
| `AJISAI_S3_PREFIX` | × | — | S3 キープレフィックス |
| `AJISAI_S3_ENDPOINT` | × | — | S3 互換エンドポイント (R2, MinIO 等) |
| `AWS_ACCESS_KEY_ID` | × | — | AWS アクセスキー (S3 使用時) |
| `AWS_SECRET_ACCESS_KEY` | × | — | AWS シークレットキー (S3 使用時) |

---

## 6. MCP ツール一覧

### メモリ操作

| ツール | 説明 |
|---|---|
| `memory_create` | 記憶を作成 (type/scope/tags) |
| `memory_get` | ID で記憶を取得 |
| `memory_update` | 記憶を更新 (自動バージョン記録) |
| `memory_delete` | 記憶を削除 |
| `memory_search` | FTS5 全文検索 |
| `memory_list` | フィルタ付き一覧 |
| `memory_history` | バージョン履歴 |
| `memory_restore` | 過去バージョンに復元 |

### データ取り込み

| ツール | 説明 |
|---|---|
| `memory_import` | Claude Code の memory ファイルを取り込み |
| `import_claude_ai` | Claude.ai エクスポート (会話+記憶+プロジェクト) を取り込み |

### 会話管理

| ツール | 説明 |
|---|---|
| `conversation_index` | Claude Code の JSONL をスキャン・インデックス |
| `conversation_list` | インデックス済み会話の一覧 |
| `conversation_get` | 会話のメッセージ or 生データ取得 |
| `conversation_search` | 会話内全文検索 |
| `conversation_archive` | 会話を S3 にアーカイブ |
| `conversation_fetch` | アーカイブから生データを取得 |

### プロジェクト統合

| ツール | 説明 |
|---|---|
| `project_unify` | 散在ディレクトリの自動検出 |
| `project_link` | パスを論理プロジェクトに手動紐付け |
| `project_unlink` | 紐付け解除 |
| `project_list` | 論理プロジェクト一覧 |

---

## 7. データの保存先

```
~/.ajisai/
├── ajisai.db              # SQLite (メモリ + 会話インデックス + プロジェクト統合)
└── archives/              # ローカルアーカイブ (S3 未設定時)
    └── conversations/
        └── claude-code/

~/.claude/projects/        # Claude Code 元データ (読み取り専用、変更しない)

s3://<bucket>/<prefix>/    # S3 アーカイブ
├── conversations/
│   ├── claude-code/       # Claude Code 会話 (JSONL)
│   └── claude-ai/         # Claude.ai 会話 (JSON)
└── metadata/              # sessions-index.json 等
```

---

## 8. よくある操作

### 初回セットアップ後の全データ取り込み

```
1. memory_import                          ← Claude Code の memory を取り込み
2. conversation_index                     ← Claude Code の会話をインデックス
3. conversation_archive                   ← 会話を S3 にアーカイブ
4. import_claude_ai(exportDir: "~/Downloads/data-...")  ← Claude.ai データを取り込み
5. project_unify                          ← 散在プロジェクトを検出
6. project_link で手動統合                ← 必要に応じて
```

### 定期バックアップ

```
conversation_archive    ← 新しい会話を S3 に追加 (冪等、差分のみ)
```
