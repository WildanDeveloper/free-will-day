#!/usr/bin/env bash
# Build both halves and start them. Intended for the VPS.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "no .env found; copy .env.example and fill in MODEL_API_KEY" >&2
  exit 1
fi

echo "building supervisor..."
go build -o bin/supervisor ./cmd/supervisor

mkdir -p bin var/log

echo "starting agent + supervisor..."
node cmd/agent/main.ts &
AGENT_PID=$!
./bin/supervisor &
SUP_PID=$!

cleanup() {
  echo
  echo "stopping..."
  touch "${STOP_FILE:-/STOP}" 2>/dev/null || true
  wait "$AGENT_PID" 2>/dev/null || true
  kill "$SUP_PID" 2>/dev/null || true
}
trap cleanup INT TERM

echo "agent pid $AGENT_PID, supervisor pid $SUP_PID"
echo "dashboard: ssh -N -L ${SUPERVISOR_ADDR:-127.0.0.1:8080}:${SUPERVISOR_ADDR:-127.0.0.1:8080} <you>@<vps>"
wait "$AGENT_PID"