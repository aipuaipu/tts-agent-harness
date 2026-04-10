#!/bin/bash
# 停止 P3 server（通过 pidfile 或端口范围查找）
#
# 兼容单 worker (p3.pid) 和多 worker (p3.pids) 两种 pidfile 格式。
#
# Usage:
#   source scripts/stop-p3-server.sh [<work_dir>] [<base_port>] [<workers>]

P3_WORK_DIR="${1:-.}"
P3_PORT="${2:-5555}"
P3_WORKERS="${3:-1}"

if ! [[ "$P3_WORKERS" =~ ^[0-9]+$ ]] || [[ "$P3_WORKERS" -lt 1 ]]; then
  P3_WORKERS=1
fi

P3_PID_FILE_SINGLE="$P3_WORK_DIR/p3.pid"
P3_PID_FILE_MULTI="$P3_WORK_DIR/p3.pids"

_graceful_kill() {
  local pid=$1
  kill "$pid" 2>/dev/null || return 0
  # 等待最多 5 秒
  for _i in $(seq 1 5); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  # 仍未退出，强制 kill
  kill -9 "$pid" 2>/dev/null || true
}

KILLED=false

# 1a. 多 worker pidfile
if [[ -f "$P3_PID_FILE_MULTI" ]]; then
  while IFS= read -r pid; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      _graceful_kill "$pid"
      KILLED=true
    fi
  done < "$P3_PID_FILE_MULTI"
  rm -f "$P3_PID_FILE_MULTI"
fi

# 1b. 单 worker pidfile
if [[ -f "$P3_PID_FILE_SINGLE" ]]; then
  PID=$(cat "$P3_PID_FILE_SINGLE" 2>/dev/null)
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    _graceful_kill "$PID"
    KILLED=true
  fi
  rm -f "$P3_PID_FILE_SINGLE"
fi

# 2. 端口范围兜底清理
for ((i=0; i<P3_WORKERS; i++)); do
  check_port=$((P3_PORT + i))
  PORT_PIDS=$(lsof -ti:"$check_port" 2>/dev/null || true)
  if [[ -n "$PORT_PIDS" ]]; then
    for pid in $PORT_PIDS; do
      _graceful_kill "$pid"
    done
    KILLED=true
  fi
done

if [[ "$KILLED" == true ]]; then
  echo "  P3 server stopped"
fi
