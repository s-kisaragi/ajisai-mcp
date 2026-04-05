#!/bin/bash
# Start ajisai-mcp with cloudflared tunnel + OAuth authentication.
# Outputs connection info for Claude.ai / Claude iOS.

set -e

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

# 1. Start cloudflared tunnel
echo "Starting cloudflared tunnel..."
cloudflared tunnel --url "http://localhost:$AJISAI_PORT" > /tmp/cloudflared-ajisai.log 2>&1 &
TUNNEL_PID=$!

for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -o "https://.*trycloudflare.com" /tmp/cloudflared-ajisai.log 2>/dev/null | head -1)
  [ -n "$TUNNEL_URL" ] && break
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "ERROR: Failed to get tunnel URL after 30s"
  kill $TUNNEL_PID 2>/dev/null
  exit 1
fi

echo "Tunnel: $TUNNEL_URL"

# 2. Start server
export AJISAI_BASE_URL="$TUNNEL_URL"
node "$SCRIPT_DIR/dist/index.js" &
SERVER_PID=$!
sleep 2

if ! curl -s "http://localhost:$AJISAI_PORT/health" > /dev/null 2>&1; then
  echo "ERROR: Server failed to start"
  kill $SERVER_PID $TUNNEL_PID 2>/dev/null
  exit 1
fi

# 3. Pre-register OAuth client for Claude.ai
CLIENT=$(curl -s -X POST "$TUNNEL_URL/register" \
  -H "Content-Type: application/json" \
  -d '{"redirect_uris":["https://claude.ai/api/mcp/oauth/callback"],"client_name":"Claude.ai"}')

CLIENT_ID=$(node -e "console.log(JSON.parse(process.argv[1]).client_id)" "$CLIENT")
CLIENT_SECRET=$(node -e "console.log(JSON.parse(process.argv[1]).client_secret)" "$CLIENT")

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
echo "  Claude.ai: Settings > Integrations > Add"
echo "  iOS:       Settings > MCP Servers > Add"
echo ""
echo "  Press Ctrl+C to stop."
echo "============================================"

trap "kill $SERVER_PID $TUNNEL_PID 2>/dev/null; echo ''; echo 'Stopped.'" EXIT INT TERM
wait
