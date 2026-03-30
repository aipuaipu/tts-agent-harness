#!/bin/bash
# 停止 P3 server（通过 PID 文件或端口查找）
#
# Usage:
#   source scripts/stop-p3-server.sh [<work_dir>] [<port>]

P3_WORK_DIR="${1:-.}"
P3_PORT="${2:-5555}"
P3_PID_FILE="$P3_WORK_DIR/p3.pid"

KILLED=false

# 1. 通过 PID 文件
if [[ -f "$P3_PID_FILE" ]]; then
  PID=$(cat "$P3_PID_FILE" 2>/dev/null)
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
    KILLED=true
  fi
  rm -f "$P3_PID_FILE"
fi

# 2. 通过端口（兜底）
PORT_PIDS=$(lsof -ti:"$P3_PORT" 2>/dev/null || true)
if [[ -n "$PORT_PIDS" ]]; then
  echo "$PORT_PIDS" | xargs kill 2>/dev/null || true
  sleep 1
  lsof -ti:"$P3_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
  KILLED=true
fi

if [[ "$KILLED" == true ]]; then
  echo "  P3 server stopped"
fi
