# TTS Agent Harness

A multi-agent harness for automated TTS (Text-to-Speech) production with quality validation. Input a script, get back audio + time-aligned subtitles.

## Architecture

```
Script (JSON)
  |
  v
+---------------- Harness (run.sh + chunks.json) -----------------+
|                                                                   |
|  [P1]  Deterministic chunking (JS)    -- text -> chunks          |
|  [P2]  Fish TTS Agent (S2-Pro)        -- text -> speech          |
|  [+2]  Deterministic pre-check        -- WAV exists/duration/rate |
|  [P3]  WhisperX Agent                 -- speech -> text + timestamps |
|  [P5]  Deterministic subtitles (JS)   -- timestamps -> per-chunk subs |
|  [P6]  Deterministic concat (JS)      -- concat + offset -> final |
|  [V2]  Review preview                 -- HTML audio + subtitle highlight |
|                                                                   |
|  State: chunks.json status + trace.jsonl                         |
+-----------------------------------------------------------------+
  |
  v
Output: per-shot WAV + subtitles.json + durations.json + preview.html
```

Production pipeline: **P1 → P2 → P3 → P5 → P6 → V2** (P4 Claude validation skipped).

P4 (Claude Agent for auto-fix) is available but not used in production — English pronunciation issues are resolved by manually editing `text_normalized` and re-running P2.

### Supported Services

- **TTS**: [Fish Audio](https://fish.audio) S2-Pro — `normalize: false`, supports `[break]`/`[breath]` control tags
- **Transcription**: [WhisperX](https://github.com/m-bain/whisperX) (local, no API needed)
- **Validation** (optional): [Claude API](https://docs.anthropic.com/) (Anthropic) — only needed if running P4

### Prerequisites

- Node.js 18+
- Python 3.11 (for WhisperX)
- ffmpeg + ffprobe
- [Fish TTS](https://fish.audio) API key

### Setup

```bash
# 1. Clone
git clone <repo-url> tts-agent-harness
cd tts-agent-harness

# 2. Python venv + WhisperX
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 3. Configure
cp example/.env.example .env
# Edit .env with your Fish TTS API key
```

### Run

```bash
source .env
bash run.sh example/demo-script.json demo
```

The pipeline will:
1. **P1**: Split segments into chunks (sentence-based, ≤200 chars)
2. **P2**: Synthesize each chunk via Fish TTS S2-Pro (parallel, with retry)
3. **Pre-check**: Verify WAV files (duration, speech rate)
4. **P3**: Start WhisperX server, batch transcribe for timestamps
5. **P5**: Generate time-aligned subtitles (strip control tags, ≤20 chars/line)
6. **P6**: Concatenate audio with padding/gaps, compute global subtitle offsets
7. **V2**: Opens HTML preview — play audio with progressive subtitle reveal

### Resume from a step

```bash
bash run.sh example/demo-script.json demo --from p3
```

### Fix a single chunk

When a chunk has pronunciation issues:

1. Edit `text_normalized` in `.work/<episode>/chunks.json`
2. Re-run P2 for that chunk: `node scripts/p2-synth.js --chunks ... --outdir ... --chunk shot01_chunk02`
3. Listen, repeat if needed
4. Resume: `bash run.sh ... --from p3`

## Script Format

```json
{
  "title": "Episode Title",
  "segments": [
    {
      "id": 1,
      "type": "hook",
      "text": "The text to be spoken. Can include [break] control tags."
    }
  ]
}
```

The `text` field serves as both TTS input and subtitle source. S2-Pro control tags (`[break]`, `[breath]`, `[long break]`, phoneme markup) are passed through to TTS and automatically stripped by P5 before subtitle generation.

## Output

```
.work/<episode>/
  chunks.json         # State machine
  subtitles.json      # Time-aligned subtitles
  trace.jsonl         # Structured execution trace
  preview.html        # V2 review page
  output/<shot>.wav   # Per-shot concatenated audio
  output/durations.json
```

### subtitles.json format

```json
{
  "shot01": [
    { "id": "sub_001", "text": "Original script text", "start": 0.2, "end": 2.54 }
  ]
}
```

## Configuration

### Environment Variables (.env)

| Variable | Required | Description |
|----------|----------|-------------|
| `FISH_TTS_KEY` | Yes | Fish TTS API key |
| `FISH_TTS_REFERENCE_ID` | No | Voice clone reference ID |
| `FISH_TTS_MODEL` | No | Override model (default: `s2-pro`) |
| `TTS_SPEED` | No | Playback speed (default: `1.15`) |

Priority: env var > `.harness/config.json` > code defaults.

### config.json defaults

| Key | Value | Notes |
|-----|-------|-------|
| `p2.model` | `s2-pro` | Fish TTS model |
| `p2.default_speed` | `1.15` | atempo post-processing |
| `p2.temperature` | `0.3` | TTS sampling temperature |
| `p2.top_p` | `0.5` | TTS sampling top_p |
| `p2.concurrency` | `3` | Parallel TTS calls |

### Proxy

P2 uses `HTTPS_PROXY` for proxy support (e.g., `HTTPS_PROXY=http://127.0.0.1:7890`).

## Testing

```bash
# Unit tests (offline, ~2s)
bash test/run-unit.sh

# P1 only, no API needed
bash test.sh --p1-only

# P1→P6, skip P4 (needs FISH_TTS_KEY)
bash test.sh --no-p4

# Full with P4 (needs FISH_TTS_KEY + Claude API)
bash test.sh
```

### AB Parameter Test

`test/ab-param-test/` — Tests the effect of Fish TTS temperature/top_p on English keyword pronunciation accuracy. See its README for details.

## License

MIT
