#!/usr/bin/env python3
"""
P3 — WhisperX Agent（HTTP Server + Batch 模式）

两种运行方式：
  1. Server 模式：加载模型后常驻，暴露 HTTP 接口供批量转写调用
     python scripts/p3-transcribe.py --server --port 5555

  2. Client 模式（通过 p3-client.js 或直接 curl）：
     curl -X POST http://localhost:5555/transcribe \
       -H 'Content-Type: application/json' \
       -d '{"audio_path": "...", "chunk_id": "...", "text": "...", "text_normalized": "...", "outdir": "..."}'

Server 启动后打印 "READY" 到 stdout，调用方以此判断模型加载完成。
"""

import argparse
import json
import os
import sys
import signal
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

import torch
import whisperx

# Import sibling events module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import events  # noqa: E402

DEVICE = "cpu"
LANGUAGE = "zh"
BATCH_SIZE = 8
COMPUTE_TYPE = "int8"

# 全局模型引用（server 模式下共享）
_model = None
_align_model = None
_align_metadata = None


def load_models():
    global _model, _align_model, _align_metadata
    if _model is not None:
        return

    print("  Loading WhisperX model...", flush=True)
    _model = whisperx.load_model(
        "large-v3",
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
        language=LANGUAGE,
    )

    print("  Loading alignment model...", flush=True)
    _align_model, _align_metadata = whisperx.load_align_model(
        language_code=LANGUAGE,
        device=DEVICE,
    )
    print("  Models loaded.", flush=True)


def transcribe_audio(audio_path: str) -> dict:
    """转写单个音频文件，返回 WhisperX 结果"""
    audio = whisperx.load_audio(audio_path)
    result = _model.transcribe(audio, batch_size=BATCH_SIZE, language=LANGUAGE)
    result = whisperx.align(
        result["segments"],
        _align_model,
        _align_metadata,
        audio,
        device=DEVICE,
        return_char_alignments=False,
    )
    return result


def format_output(chunk_id, shot_id, text, text_normalized, result):
    """将 WhisperX 结果格式化为标准输出"""
    output = {
        "chunk_id": chunk_id,
        "shot_id": shot_id,
        "original_text": text,
        "original_normalized": text_normalized,
        "segments": [],
    }

    full_text_parts = []
    for seg in result.get("segments", []):
        seg_out = {
            "text": seg.get("text", "").strip(),
            "start": round(seg.get("start", 0), 3),
            "end": round(seg.get("end", 0), 3),
            "words": [],
        }
        for w in seg.get("words", []):
            seg_out["words"].append({
                "word": w.get("word", ""),
                "start": round(w.get("start", 0), 3),
                "end": round(w.get("end", 0), 3),
            })
        output["segments"].append(seg_out)
        full_text_parts.append(seg_out["text"])

    output["full_transcribed_text"] = "".join(full_text_parts)
    return output


# =============================================================
# HTTP Server 模式
# =============================================================

class TranscribeHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/transcribe":
            self._handle_transcribe()
        elif self.path == "/health":
            self._respond(200, {"status": "ok"})
        else:
            self._respond(404, {"error": "not found"})

    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"status": "ok"})
        else:
            self._respond(404, {"error": "not found"})

    def _handle_transcribe(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))

            audio_path = body["audio_path"]
            chunk_id = body.get("chunk_id", "unknown")
            shot_id = body.get("shot_id", "")
            text = body.get("text", "")
            text_normalized = body.get("text_normalized", "")
            outdir = body.get("outdir", "")

            if not os.path.exists(audio_path):
                self._respond(400, {"error": f"audio not found: {audio_path}"})
                return

            print(f"  [TRANSCRIBE] {chunk_id}...", flush=True)
            result = transcribe_audio(audio_path)
            output = format_output(chunk_id, shot_id, text, text_normalized, result)

            # 如果指定了 outdir，写入文件
            if outdir:
                os.makedirs(outdir, exist_ok=True)
                out_path = os.path.join(outdir, f"{chunk_id}.json")
                with open(out_path, "w", encoding="utf-8") as f:
                    json.dump(output, f, ensure_ascii=False, indent=2)
                print(f"    → {out_path}", flush=True)

            print(f"    转写: {output['full_transcribed_text'][:60]}...", flush=True)
            self._respond(200, output)

        except Exception as e:
            print(f"    [ERROR] {e}", flush=True)
            self._respond(500, {"error": str(e)})

    def _respond(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode())

    def log_message(self, format, *args):
        pass  # 静默 HTTP 日志


def run_server(port):
    load_models()
    import socket
    class ReusableHTTPServer(HTTPServer):
        allow_reuse_address = True
        allow_reuse_port = True
    server = ReusableHTTPServer(("127.0.0.1", port), TranscribeHandler)

    def shutdown(sig, frame):
        print("\n  P3 server shutting down.", flush=True)
        server.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    # READY 信号 — 调用方通过检测这行判断模型加载完成
    print(f"READY on port {port}", flush=True)
    server.serve_forever()


# =============================================================
# Batch 模式（通过 HTTP 调用 server，或直接本地处理）
# =============================================================

def run_batch(chunks_path, audiodir, outdir, chunk_id=None, server_urls=None, trace_path=None):
    """Batch 转写：如果有 server_urls 走 HTTP（可多 URL 并发），否则本地加载模型"""
    chunks = json.loads(open(chunks_path).read())
    os.makedirs(outdir, exist_ok=True)

    # workDir = parent of chunks.json
    work_dir = os.path.dirname(os.path.abspath(chunks_path))
    if not trace_path:
        trace_path = os.path.join(work_dir, "trace.jsonl")

    # Startup: opportunistic trace compaction
    try:
        events.maybe_compact_trace(trace_path)
    except Exception:
        pass

    if chunk_id:
        to_process = [c for c in chunks if c["id"] == chunk_id]
    else:
        to_process = [c for c in chunks if c.get("status") == "synth_done"]

    if not to_process:
        print("No chunks to process")
        return

    print(f"=== P3: Transcribing {len(to_process)} chunk(s) ===\n")

    if server_urls:
        _batch_via_http(chunks, to_process, audiodir, outdir, server_urls, work_dir, trace_path, chunks_path)
    else:
        load_models()
        _batch_local(chunks, to_process, audiodir, outdir, work_dir, trace_path)
        # 回写 chunks.json（本地模式单线程，最后一次性写）
        with open(chunks_path, "w", encoding="utf-8") as f:
            json.dump(chunks, f, ensure_ascii=False, indent=2)

    ok = sum(1 for c in to_process if c.get("status") == "transcribed")
    print(f"\n=== Done: {ok}/{len(to_process)} transcribed ===")

    failed = len(to_process) - ok
    if failed > 0:
        print(f"  {failed} chunk(s) failed transcription")
        sys.exit(1)


def _log_and_print(log_file, msg):
    print(msg)
    events.append_stage_log(log_file, msg)


def _batch_local(chunks, to_process, audiodir, outdir, work_dir, trace_path):
    for chunk in to_process:
        cid = chunk["id"]
        log_file = events.open_stage_log(work_dir, cid, "p3")
        events.emit_stage_start(trace_path, cid, "p3", attempt=1)
        start_ts = time.time()

        audio_path = os.path.join(audiodir, f"{cid}.wav")
        if not os.path.exists(audio_path):
            msg = f"  [SKIP] {cid}: {audio_path} not found"
            _log_and_print(log_file, msg)
            chunk["status"] = "transcribe_failed"
            chunk["error"] = f"audio not found: {audio_path}"
            events.emit_stage_end(
                trace_path, cid, "p3", "fail",
                duration_ms=int((time.time() - start_ts) * 1000),
                error=f"audio not found: {audio_path}",
            )
            continue

        _log_and_print(log_file, f"  [TRANSCRIBE] {cid}...")
        try:
            result = transcribe_audio(audio_path)
            output = format_output(
                cid, chunk.get("shot_id", ""),
                chunk["text"], chunk["text_normalized"], result
            )

            out_path = os.path.join(outdir, f"{cid}.json")
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(output, f, ensure_ascii=False, indent=2)

            _log_and_print(log_file, f"    → {out_path}")
            _log_and_print(log_file, f"    转写: {output['full_transcribed_text'][:60]}...")
            chunk["status"] = "transcribed"
            events.emit_stage_end(
                trace_path, cid, "p3", "ok",
                duration_ms=int((time.time() - start_ts) * 1000),
            )

        except Exception as e:
            _log_and_print(log_file, f"    [ERROR] {cid}: {e}")
            chunk["status"] = "transcribe_failed"
            chunk["error"] = str(e)
            events.emit_stage_end(
                trace_path, cid, "p3", "fail",
                duration_ms=int((time.time() - start_ts) * 1000),
                error=str(e),
            )


def _batch_via_http(chunks, to_process, audiodir, outdir, server_urls, work_dir, trace_path, chunks_path):
    """
    Batch 转写 via HTTP — 支持多 URL round-robin 并发。

    server_urls: list[str]，一个或多个 server URL。
    当 len(server_urls) == 1 时行为等同于原串行实现（ThreadPool max_workers=1）。
    """
    import urllib.request
    import threading
    from concurrent.futures import ThreadPoolExecutor

    # 本地 server 不走代理
    os.environ["no_proxy"] = "127.0.0.1,localhost"

    urls = list(server_urls)
    n_workers = max(1, len(urls))

    # 用于原子分配 URL 的计数器 + 锁
    rr_counter = {"n": 0}
    rr_lock = threading.Lock()

    def _next_url():
        with rr_lock:
            idx = rr_counter["n"] % len(urls)
            rr_counter["n"] += 1
            return urls[idx]

    # 写 chunks.json 的锁（多线程回写状态）
    chunks_write_lock = threading.Lock()

    def _persist_chunks():
        """线程安全回写 chunks.json。每个 chunk 完成后持久化一次，避免崩溃丢状态。"""
        with chunks_write_lock:
            with open(chunks_path, "w", encoding="utf-8") as f:
                json.dump(chunks, f, ensure_ascii=False, indent=2)

    def _worker(chunk):
        cid = chunk["id"]
        # open_stage_log 每 chunk 独立文件，天然线程安全
        log_file = events.open_stage_log(work_dir, cid, "p3")
        events.emit_stage_start(trace_path, cid, "p3", attempt=1)
        start_ts = time.time()

        audio_path = os.path.abspath(os.path.join(audiodir, f"{cid}.wav"))
        if not os.path.exists(audio_path):
            msg = f"  [SKIP] {cid}: {audio_path} not found"
            _log_and_print(log_file, msg)
            chunk["status"] = "transcribe_failed"
            chunk["error"] = f"audio not found: {audio_path}"
            events.emit_stage_end(
                trace_path, cid, "p3", "fail",
                duration_ms=int((time.time() - start_ts) * 1000),
                error=f"audio not found: {audio_path}",
            )
            _persist_chunks()
            return

        url = _next_url()
        _log_and_print(log_file, f"  [TRANSCRIBE via HTTP] {cid} -> {url}...")
        try:
            body = json.dumps({
                "audio_path": audio_path,
                "chunk_id": cid,
                "shot_id": chunk.get("shot_id", ""),
                "text": chunk["text"],
                "text_normalized": chunk["text_normalized"],
                "outdir": os.path.abspath(outdir),
            }).encode()

            req = urllib.request.Request(
                f"{url}/transcribe",
                data=body,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                result = json.loads(resp.read())

            if "error" in result:
                raise Exception(result["error"])

            _log_and_print(log_file, f"    转写: {result['full_transcribed_text'][:60]}...")
            chunk["status"] = "transcribed"
            events.emit_stage_end(
                trace_path, cid, "p3", "ok",
                duration_ms=int((time.time() - start_ts) * 1000),
            )

        except Exception as e:
            _log_and_print(log_file, f"    [ERROR] {cid}: {e}")
            chunk["status"] = "transcribe_failed"
            chunk["error"] = str(e)
            events.emit_stage_end(
                trace_path, cid, "p3", "fail",
                duration_ms=int((time.time() - start_ts) * 1000),
                error=str(e),
            )

        _persist_chunks()

    # 单 URL → max_workers=1 等价串行，行为与原实现一致
    with ThreadPoolExecutor(max_workers=n_workers) as ex:
        # list() 确保等待所有 future 完成 + 传播异常（不会传播，_worker 内部捕获）
        list(ex.map(_worker, to_process))


# =============================================================
# Entry
# =============================================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="P3: WhisperX Agent")
    parser.add_argument("--server", action="store_true", help="Run as HTTP server")
    parser.add_argument("--port", type=int, default=5555, help="Server port (default: 5555)")
    parser.add_argument("--chunks", default=None, help="Path to chunks.json (batch mode)")
    parser.add_argument("--audiodir", default=None, help="Directory with chunk WAV files")
    parser.add_argument("--outdir", default=None, help="Output directory for transcription JSON")
    parser.add_argument("--chunk", default=None, help="Process only this chunk ID")
    parser.add_argument("--server-url", default=None, help="P3 server URL for batch-via-HTTP mode (single URL, backward compat)")
    parser.add_argument("--server-urls", default=None, help="Comma-separated list of P3 server URLs for multi-worker parallel mode")
    parser.add_argument("--trace", default=None, help="Path to trace.jsonl (default: <workDir>/trace.jsonl)")
    args = parser.parse_args()

    if args.server:
        run_server(args.port)
    elif args.chunks and args.audiodir and args.outdir:
        # 合并 --server-url / --server-urls → 列表
        urls = None
        if args.server_urls:
            urls = [u.strip() for u in args.server_urls.split(",") if u.strip()]
        elif args.server_url:
            urls = [args.server_url.strip()]
        run_batch(args.chunks, args.audiodir, args.outdir, args.chunk, urls, args.trace)
    else:
        parser.print_help()
        sys.exit(1)
