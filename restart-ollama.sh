#!/usr/bin/env bash
# Kills any running Ollama server and starts a fresh one bound explicitly to
# 127.0.0.1, so qaivision can reliably reach it.
#
# Fixes a known class of issue where "localhost" resolves to IPv6 (::1) on
# the client while Ollama only listens on IPv4 (or vice versa) — the request
# never lands on the server at all, which looks like Ollama "staying idle"
# in Activity Monitor while qaivision appears to hang with no error.
#
# Usage: ./restart-ollama.sh
set -euo pipefail

PORT="${OLLAMA_PORT:-11434}"
HOST="127.0.0.1"

echo "==> Stopping any running Ollama server..."
# Covers `ollama serve` run manually, the Ollama.app menu-bar process, and
# the underlying llama-server process it spawns.
pkill -f "ollama serve" 2>/dev/null || true
pkill -f "Ollama.app" 2>/dev/null || true
pkill -x "ollama" 2>/dev/null || true
sleep 1

echo "==> Starting Ollama bound to ${HOST}:${PORT}..."
OLLAMA_HOST="${HOST}:${PORT}" nohup ollama serve > /tmp/ollama-serve.log 2>&1 &
echo "    started with PID $!, logging to /tmp/ollama-serve.log"

echo "==> Waiting for Ollama to respond..."
for i in $(seq 1 30); do
  if curl -s -m 2 "http://${HOST}:${PORT}/api/version" > /dev/null 2>&1; then
    echo "==> Ollama is up: http://${HOST}:${PORT}"
    echo ""
    echo "config/models.yaml's default ollama.host already points at"
    echo "http://127.0.0.1:${PORT} — qaivision will use this automatically."
    echo "Override for one run with:"
    echo "  AIQA_OLLAMA_HOST=http://${HOST}:${PORT} npm run run -- --env dev --site <site> --scenario <scenario>"
    exit 0
  fi
  sleep 1
done

echo "==> Ollama did not respond after 30s — check /tmp/ollama-serve.log"
exit 1
