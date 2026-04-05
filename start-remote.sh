#!/bin/bash
# ajisai-mcp リモート起動スクリプト
# cloudflared トンネル + OAuth 認証付き HTTP サーバーを起動し、
# Claude.ai / Claude iOS 用の接続情報を出力する。

set -e

# --- 設定 (環境変数で上書き可能) ---
export AJISAI_TRANSPORT=http
export AJISAI_AUTH_PASSWORD="${AJISAI_AUTH_PASSWORD:-}"
export AJISAI_S3_BUCKET="${AJISAI_S3_BUCKET:-}"
export AJISAI_S3_REGION="${AJISAI_S3_REGION:-ap-northeast-1}"
export AJISAI_S3_PREFIX="${AJISAI_S3_PREFIX:-ajisai}"
AJISAI_PORT="${AJISAI_PORT:-3000}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$AJISAI_AUTH_PASSWORD" ]; then
  echo "ERROR: AJISAI_AUTH_PASSWORD is required"
  echo "Usage: AJISAI_AUTH_PASSWORD=mypassword ./start-remote.sh"
  exit 1
fi

# --- 1. cloudflared トンネルを起動 ---
echo "Starting cloudflared tunnel..."
cloudflared tunnel --url "http://localhost:$AJISAI_PORT" > /tmp/cloudflared-ajisai.log 2>&1 &
TUNNEL_PID=$!

# トンネルURL取得を待機
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -o "https://.*trycloudflare.com" /tmp/cloudflared-ajisai.log 2>/dev/null | head -1)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "ERROR: Failed to get tunnel URL after 30s"
  kill $TUNNEL_PID 2>/dev/null
  exit 1
fi

echo "Tunnel: $TUNNEL_URL"

# --- 2. サーバー起動 ---
export AJISAI_BASE_URL="$TUNNEL_URL"
node "$SCRIPT_DIR/dist/index.js" &
SERVER_PID=$!
sleep 2

# ヘルスチェック
if ! curl -s "http://localhost:$AJISAI_PORT/health" > /dev/null 2>&1; then
  echo "ERROR: Server failed to start"
  kill $SERVER_PID $TUNNEL_PID 2>/dev/null
  exit 1
fi

# --- 3. Claude.ai 用クライアント事前登録 ---
CLIENT=$(curl -s -X POST "$TUNNEL_URL/register" \
  -H "Content-Type: application/json" \
  -d '{"redirect_uris":["https://claude.ai/api/mcp/oauth/callback"],"client_name":"Claude.ai"}')

CLIENT_ID=$(echo "$CLIENT" | python3 -c "import sys,json; print(json.load(sys.stdin)['client_id'])")
CLIENT_SECRET=$(echo "$CLIENT" | python3 -c "import sys,json; print(json.load(sys.stdin)['client_secret'])")

# --- 出力 ---
echo ""
echo "============================================"
echo "  ajisai-mcp remote server is running"
echo "============================================"
echo ""
echo "  Server URL:     $TUNNEL_URL/mcp"
echo "  Client ID:      $CLIENT_ID"
echo "  Client Secret:  $CLIENT_SECRET"
echo "  Password:       $AJISAI_AUTH_PASSWORD"
echo ""
echo "  Claude.ai: Settings → Integrations → Add"
echo "  iOS:       Settings → MCP Servers → Add"
echo ""
echo "  Press Ctrl+C to stop."
echo "============================================"

# --- Cleanup ---
trap "kill $SERVER_PID $TUNNEL_PID 2>/dev/null; echo ''; echo 'Stopped.'" EXIT INT TERM
wait
