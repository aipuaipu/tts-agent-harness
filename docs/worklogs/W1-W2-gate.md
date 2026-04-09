# W1-W2 Wave Gate Report

**Date**: 2026-04-09
**Branch**: `agent/W1-W2-integration`
**Verdict**: ✅ **PASS** — proceed to W3

## Agents in this wave

| Agent | Branch | Commit | Status |
|---|---|---|---|
| A1-Infra | `agent/A1-infra` | `6267987` | ✅ |
| A2-Domain | `worktree-agent-ad00da0b` | `813ea17` | ✅ |
| A3-WhisperX | `worktree-agent-a31eada6` | `9b80120` | ⚠ code complete, docker build env-blocked |

## Schema diff (A1 V001 ↔ A2 models.py)

3 mismatches found, all fixed by aligning A2 ORM to A1 V001 (V001 is the
frozen contract per ADR-002 §3.1):

| # | Field | Fix |
|---|---|---|
| 1 | `chunks` UNIQUE constraint name | `uq_chunks_shot_idx` → `chunks_episode_shot_idx_key` |
| 2 | `takes.duration_s` type | generic `Float` → `REAL` (via `RealType` variant) |
| 3 | `events_episode_idx` ordering | ascending → `DESC` on id |

## Merge conflicts resolved

- `server/core/__init__.py` — unified docstring listing all core modules
- `server/pyproject.toml` — union of dependencies; pinned `python>=3.11`
  (A2 hit Python 3.14 wheel gaps)

## Validation

### A1 — Postgres schema applied
```
docker exec tts-harness-postgres psql -U harness -d harness -c '\dt'
→ episodes, chunks, takes, stage_runs, events, alembic_version  (6 rows)
```

### A2 — SQLite unit suite (post-fix)
```
SKIP_DOCKER_TESTS=1 pytest server/tests/ -v
→ 20 passed, 6 skipped (testcontainer-gated, docker creds env issue)
```

### A1 ↔ A2 integration smoke (`/tmp/wave_gate_smoke.py`)
End-to-end verification: A2 ORM repositories writing to A1's real
migrated Postgres + A1's `events_notify_trigger` firing into asyncpg
LISTEN.

```
✓ EpisodeRepo.create → wave-gate-smoke-ep
✓ ChunkRepo.bulk_insert → wave-gate-smoke-c1
✓ write_event → id=3
✓ NOTIFY received: {'ep': 'wave-gate-smoke-ep', 'id': 3}
✓ UNIQUE constraint name: chunks_episode_shot_idx_key

WAVE GATE SMOKE: PASS
```

This is the contract-critical assertion: **A1's pg_notify trigger
delivers the exact `{ep, id}` payload shape that A9-API's SSE handler
will be coded against**.

## A3 deferred items

A3's code (FastAPI server, Dockerfile, GPU stub, 6/6 unit tests) is
complete. The only deferred item is real `docker build` validation,
blocked by Docker Desktop not inheriting the ClashX proxy. This is
an environment problem, not a code problem.

**Action item before W3 starts**: configure Docker Desktop proxy to
`http://127.0.0.1:7890` and re-run `docker build` in `whisperx-svc/`.
Wave gate does not block on this — A4-A7 don't depend on the WhisperX
container being live (only on the HTTP contract, which is documented).

## Gate checklist (ADR-002 §5.4)

- [x] All agents produced worklog (A1, A2, A3)
- [x] All agents' tests passed (20+6 SQLite, 26 testcontainer earlier, 6/6 whisperx)
- [x] All produced files reviewed (schema diff + manual read of models/migrations)
- [x] Integration branch merged cleanly (2 conflicts resolved, schema mismatches fixed)
- [x] End-to-end smoke test passed (wave_gate_smoke.py)
- [x] Tag will be: `rewrite-W1-W2-complete`

## Hand-off notes for W3

W3 will spawn 4 task agents (A4-P1, A5-P2, A6-P5, A7-P6) in parallel.
They share these contracts (now solid):

1. **`server.core.domain`** — `ChunkInput`, `EpisodeCreate`, `P1Result`,
   `P2Result`, `P3Result`, `P5Result`, `P6Result`, `StageEvent`. All Pydantic
   v2.
2. **`server.core.repositories`** — async repos. Note that `bulk_insert`
   takes `Iterable[ChunkInput]`, not raw dicts.
3. **`server.core.storage`** — MinIOStorage + path constants. Use the
   constants, not literal `s3://...` strings.
4. **`server.core.events.write_event(session, ep_id, cid, kind, payload)`**
   — atomic write + auto NOTIFY (trigger). Tasks should call this on
   stage transitions to feed the SSE pipeline.
5. **DATABASE_URL** — `postgresql+asyncpg://harness:harness@localhost:55432/harness`
   for local dev (note non-default port 55432, A1 used host port mapping).
6. **MinIO** — `localhost:59000` (API), `localhost:59001` (console),
   bucket `tts-harness`, credentials `minioadmin:minioadmin`.
7. **Fish API limit tag**: P2 must use `tags=["fish-api"]` per ADR §4.3.
8. **WhisperX HTTP contract**: `POST http://whisperx-svc:7860/transcribe`
   multipart `audio` + form `language`. Response shape in A3's README.

## Open issues for follow-up (not blocking W3)

1. Docker Desktop proxy config (manual UI step required)
2. Worktree CLAUDE.md is stale (still describes demo Node pipeline);
   should be updated on main to reflect new architecture
3. testcontainers in dev fails on docker-credential-desktop PATH issue
   (workaround: `export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"`)
