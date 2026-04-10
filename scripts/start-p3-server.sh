#!/bin/bash
# 启动 P3 WhisperX server（支持单进程或多 worker 并行模式）
#
# 单 worker（默认，workers=1）：
#   - 监听 <base_port>
#   - pidfile: <work_dir>/p3.pid
#   - log:     <work_dir>/p3-server.log
#   - 与旧版行为完全一致
#
# 多 worker（workers>1）：
#   - 分别监听 <base_port>, <base_port>+1, ..., <base_port>+workers-1
#   - pidfile: <work_dir>/p3.pids（每行一个 PID）
#   - log:     <work_dir>/p3-server-<i>.log（i = 0..workers-1）
#   - 所有进程 /health ok 才返回成功
#
# 启动前自动清理：
#   - 检查旧 pidfile（p3.pid / p3.pids）杀旧进程
#   - 检查所有将使用的端口，杀占用进程
#
# Usage:
#   source scripts/start-p3-server.sh <base_port> <venv_activate_path> <script_path> <work_dir> [<workers>]
#   echo $P3_PID   # 首个 worker 的 PID（向后兼容）
#   echo $P3_URLS  # 逗号分隔的 URL 列表
#
# Caller is responsible for shutdown via stop-p3-server.sh.

P3_PORT="${1:?Usage: start-p3-server.sh <base_port> <venv_activate> <script_path> <work_dir> [<workers>]}"
VENV_ACTIVATE="${2:?}"
P3_SCRIPT="${3:?}"
P3_WORK_DIR="${4:-.}"
P3_WORKERS="${5:-1}"

if ! [[ "$P3_WORKERS" =~ ^[0-9]+$ ]] || [[ "$P3_WORKERS" -lt 1 ]]; then
  echo "ERROR: workers must be a positive integer, got: $P3_WORKERS"
  return 1 2>/dev/null || exit 1
fi

P3_PID_FILE_SINGLE="$P3_WORK_DIR/p3.pid"
P3_PID_FILE_MULTI="$P3_WORK_DIR/p3.pids"

if [[ ! -f "$VENV_ACTIVATE" ]]; then
  echo "ERROR: Python venv not found at $VENV_ACTIVATE"
  return 1 2>/dev/null || exit 1
fi

# --- 清理旧进程 ---

_kill_pid() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "  Killing old P3 server (PID $pid from pidfile)..."
    kill "$pid" 2>/dev/null
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
}

# 1a. 旧单 worker pidfile
if [[ -f "$P3_PID_FILE_SINGLE" ]]; then
  _kill_pid "$(cat "$P3_PID_FILE_SINGLE" 2>/dev/null)"
  rm -f "$P3_PID_FILE_SINGLE"
fi

# 1b. 旧多 worker pidfile
if [[ -f "$P3_PID_FILE_MULTI" ]]; then
  while IFS= read -r old_pid; do
    _kill_pid "$old_pid"
  done < "$P3_PID_FILE_MULTI"
  rm -f "$P3_PID_FILE_MULTI"
fi

# 2. 清理所有将要使用的端口
for ((i=0; i<P3_WORKERS; i++)); do
  check_port=$((P3_PORT + i))
  PORT_PIDS=$(lsof -ti:"$check_port" 2>/dev/null || true)
  if [[ -n "$PORT_PIDS" ]]; then
    echo "  Port $check_port occupied by PID(s): $PORT_PIDS — killing..."
    echo "$PORT_PIDS" | xargs kill 2>/dev/null || true
    sleep 1
    PORT_PIDS=$(lsof -ti:"$check_port" 2>/dev/null || true)
    if [[ -n "$PORT_PIDS" ]]; then
      echo "$PORT_PIDS" | xargs kill -9 2>/dev/null || true
      sleep 1
    fi
  fi
done

# --- 启动 ---

source "$VENV_ACTIVATE"

# 离线模式：跳过 HuggingFace API 版本检查，直接用本地缓存模型
export HF_HUB_OFFLINE=1

mkdir -p "$P3_WORK_DIR"

_started_pids=()
_started_ports=()
_started_logs=()

for ((i=0; i<P3_WORKERS; i++)); do
  worker_port=$((P3_PORT + i))
  if [[ "$P3_WORKERS" -eq 1 ]]; then
    worker_log="$P3_WORK_DIR/p3-server.log"
  else
    worker_log="$P3_WORK_DIR/p3-server-$i.log"
  fi
  echo "  Starting P3 WhisperX server [worker $i] on port $worker_port..."
  python "$P3_SCRIPT" --server --port "$worker_port" &>"$worker_log" &
  _started_pids+=($!)
  _started_ports+=("$worker_port")
  _started_logs+=("$worker_log")
done

# 写 PID 文件
if [[ "$P3_WORKERS" -eq 1 ]]; then
  echo "${_started_pids[0]}" > "$P3_PID_FILE_SINGLE"
else
  : > "$P3_PID_FILE_MULTI"
  for pid in "${_started_pids[@]}"; do
    echo "$pid" >> "$P3_PID_FILE_MULTI"
  done
fi

# 导出首个 PID 以保持旧调用方兼容
P3_PID="${_started_pids[0]}"

# 等所有 worker /health 就绪
_ready_mask=()
for ((i=0; i<P3_WORKERS; i++)); do _ready_mask+=(0); done

for attempt in $(seq 1 120); do
  all_ready=true
  for ((i=0; i<P3_WORKERS; i++)); do
    if [[ "${_ready_mask[$i]}" -eq 1 ]]; then continue; fi
    port="${_started_ports[$i]}"
    pid="${_started_pids[$i]}"
    if curl -s --noproxy 127.0.0.1 "http://127.0.0.1:$port/health" 2>/dev/null | grep -q ok; then
      _ready_mask[$i]=1
      echo "  P3 worker $i ready (PID $pid, port $port)"
    elif ! kill -0 "$pid" 2>/dev/null; then
      echo "ERROR: P3 worker $i died during startup. Log: ${_started_logs[$i]}"
      tail -20 "${_started_logs[$i]}" 2>/dev/null || true
      # 清理其他 worker
      for other_pid in "${_started_pids[@]}"; do
        kill "$other_pid" 2>/dev/null || true
      done
      rm -f "$P3_PID_FILE_SINGLE" "$P3_PID_FILE_MULTI"
      return 1 2>/dev/null || exit 1
    else
      all_ready=false
    fi
  done
  if [[ "$all_ready" == true ]]; then
    # 构建 P3_URLS
    _urls=()
    for p in "${_started_ports[@]}"; do
      _urls+=("http://127.0.0.1:$p")
    done
    P3_URLS=$(IFS=,; echo "${_urls[*]}")
    export P3_URLS
    echo "  All P3 workers ready (${P3_WORKERS} worker(s), ${attempt}x2s)"
    echo "  P3_URLS=$P3_URLS"
    return 0 2>/dev/null || exit 0
  fi
  sleep 2
done

echo "ERROR: P3 server(s) failed to start within 240s"
for pid in "${_started_pids[@]}"; do
  kill "$pid" 2>/dev/null || true
done
rm -f "$P3_PID_FILE_SINGLE" "$P3_PID_FILE_MULTI"
return 1 2>/dev/null || exit 1
