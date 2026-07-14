#!/usr/bin/env bash
# One-shot setup for qaivision on a fresh machine.
# Usage: ./setup.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Checking prerequisites"
command -v node >/dev/null || { echo "Node.js 20+ is required: https://nodejs.org"; exit 1; }
command -v ollama >/dev/null || { echo "Ollama is required: https://ollama.com/download"; exit 1; }

echo "==> Installing npm dependencies"
npm install

echo "==> Installing Playwright's Chromium browser"
npx playwright install chromium

echo "==> Making sure Ollama is running"
if ! curl -s -m 2 http://localhost:11434/api/version >/dev/null 2>&1; then
  echo "Starting 'ollama serve' in the background..."
  nohup ollama serve > /tmp/ollama-serve.log 2>&1 &
  sleep 2
fi

PLANNER_MODEL=$(grep -A2 '^planner:' config/models.yaml | grep 'model:' | awk '{print $2}')
VISION_MODEL=$(grep -A2 '^vision:' config/models.yaml | grep 'model:' | awk '{print $2}')

echo "==> Pulling planner model: ${PLANNER_MODEL}"
ollama pull "${PLANNER_MODEL}"

echo "==> Pulling vision model: ${VISION_MODEL}"
ollama pull "${VISION_MODEL}"

if [ ! -f config/credentials.yaml ]; then
  echo "==> Creating config/credentials.yaml from template"
  cp config/credentials.example.yaml config/credentials.yaml
  echo "    Edit config/credentials.yaml with real per-env/site credentials before testing real sites."
fi

echo ""
echo "Setup complete."
echo "  1. Fill in config/sites.yaml, config/products.yaml, config/credentials.yaml for your site."
echo "  2. npm run run -- --env dev --site kabi-us --scenario smoke"
echo ""
echo "Then open the live viewer URL printed by the run (default http://localhost:4180)."
