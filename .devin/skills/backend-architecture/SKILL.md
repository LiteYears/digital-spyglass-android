---
name: backend-architecture
description: IntelShed backend reference — briefing pipeline, LLM cascade, key subsystems, Docker/PG mode, MCP tools. Invoke when working on backend or needing API endpoints.
triggers:
  - user
  - model
---

# Backend Architecture Reference

## Briefing pipeline

```
_gather_snapshot()  →  intel_briefing.gather_for_briefing()  →  format_digest_sections()
                              ↓                                       ↓
                    live feeds (GDELT, quakes, …)              FtM graph (who/what)
                              ↓
                    build_security_advisor_prompt()  →  LLM cascade  →  SQLite briefings
```

| Action | Endpoint |
|--------|----------|
| Latest briefing | `GET /api/briefing` — text, digest, intel, quality, fusion_hotspots, insights |
| Force generate | `POST /api/briefing/generate` (`?force=1` bypasses cache) |
| Insight cards | `GET /api/insights?top=5` — fusion-ranked, narrated |
| FtM subgraph | `GET /api/intel/subgraph?hops=2&bbox=` — temporal edge decay |
| Autopilot | `WORLDBASE_BRIEFING_AUTOPILOT=1` (default on), 6h interval |
| Prediction ledger | `quality.meta.prediction_accuracy_30d` / `prediction_pending` |

## LLM cascade

`llm_provider.py` central dispatch: NVIDIA-first, Ollama fallback.

- NVIDIA NIM 3-model cascade: `nemotron-3-super-120b` → `nemotron-3-ultra-550b` → `mistral-nemotron` (`_MAX_CASCADE_MODELS=3`)
- Primary model: `nvidia/nemotron-3-ultra-550b-a55b` (`WORLDBASE_NVIDIA_MODEL`)
- Ollama fallback: `qwen3:8b` (`provider="ollama"` kwarg skips NVIDIA)
- Config: `llm_config.py`
- 748 API routes total — `GET /openapi.json` for full list

## Key subsystems

| Subsystem | Files | Flag | Notes |
|-----------|-------|------|-------|
| Trust V2 | `claim_trust_scoring.py`, `trust_v2_*.py`, `evidence_dag.py` | `WORLDBASE_TRUST_SCHEMA_V2=0` | F1=0.788, 5/6 feedback loops shipped |
| Entity Resolution | `entity_resolution.py`, `entity_resolution_llm.py` | `WORLDBASE_ENTITY_RESOLUTION_PIPELINE=single` | Splink + LLM adjudication |
| Agent Orchestrator | `agent_orchestrator.py`, `agent_blackboard.py` | `WORLDBASE_AGENT_ORCHESTRATION=0` | 5-agent pipeline, loop detection |
| Fusion Heatmap | `fusion_heatmap.py` | `WORLDBASE_SPATIAL_LISA=0` | LISA Local Moran's I, GNN + anomaly inputs |
| RAG | `rag_memory.py`, `rag_rerank.py`, `query_router.py` | `WORLDBASE_QUERY_ROUTER=1` | BGE rerank, 5-route classifier, CRAG-lite |
| Evidence DAG | `evidence_dag.py`, `evidence_vault.py` | `WORLDBASE_EVIDENCE_DAG=0` | W3C PROV, Merkle checkpoints, tamper detection |
| Operations Agent | `operations_agent.py`, `ops_shadow.py`, `ops_approval.py` | `WORLDBASE_OPS_AGENT=0` | ORGA cycle, Phase 1 read-only |
| Mesh | `mesh_identity.py`, `mesh_federated.py`, `edge_autonomy.py` | `WORLDBASE_MESH_IDENTITY=0` | Ed25519, FedAvg, Pi edge autonomy |
| OSINT | `identity_osint.py`, `domain_intel.py`, `onion_directory.py` | various | 16 OSINT bridges, ~2400 LOC |
| Darkweb | `darkweb_tor.py`, `darkweb_parsers.py` | `WORLDBASE_DARKWEB=1` | Ahmia/Tor engines, ransomware, breach monitoring |
| TTS + Whisper | `tts_bridge.py`, `whisper_bridge.py` | `WORLDBASE_WHISPER_BRIDGE=0` | Piper TTS, faster-whisper CUDA |

## Docker mode

| Service | URL |
|---------|-----|
| UI | https://localhost |
| API | https://localhost/api |
| OpenAPI | https://localhost/api/docs |

**CRITICAL — Never run venv backend and Docker stack at the same time.** Check: `netstat -ano | findstr :8002` — if `LISTENING` while `docker ps` shows `worldbase-backend-1`, stop the venv.

**Docker feature flags gotcha:** `GET /api/admin/flags` shows many flags as `enabled: false`. This is expected — code defaults in `config.py`/`features.py` apply at runtime (e.g. `WORLDBASE_QUERY_ROUTER` defaults `"1"`).

**Docker Caddy from Windows:** `curl -sk https://localhost` may return empty. Use a browser instead.

## PostgreSQL mode

When `DATABASE_URL` is set, backend runs in PostgreSQL mode. `db_adapter.py` provides dual-DB abstraction. Key gotchas:
- SQLite virtual tables (`vec0`, `fts5`) don't exist in PG — RAG vector/FTS search is SQLite-only
- `HAVING` clause: use `HAVING COUNT(*) >= ?` not `HAVING cnt >= ?` (PG doesn't allow aliases)
- `schema_init.py` auto-resets all SERIAL sequences at startup
- Only 4 files retain `import sqlite3`: `db_adapter.py`, `sqlite_bootstrap.py`, `duckdb_queue.py`, `ais_trajectory.py`

Full PG compat details: [`docs/AGENTS_ARCHIVE_2026-08-13.md`](docs/AGENTS_ARCHIVE_2026-08-13.md) § PostgreSQL compatibility.

## MCP tools (intelshed server)

10 meta-tools, 80+ sub-tools via dispatch. Config: `http://127.0.0.1:18002/api/mcp/` (direct HTTP, bypasses Caddy SSL). Header: `X-API-Key` (see `backend/.env`).

Meta-tools: `worldbase_query`, `worldbase_briefing_action`, `worldbase_chat_query`, `worldbase_investigate_target`, `worldbase_globe_control`, `worldbase_mesh_control`, `worldbase_list_tools`, `worldbase_describe_tool`, `worldbase_search_tools`, `worldbase_status_check`.

If MCP fails: check `netstat -ano | findstr 18002`. If WinNAT blocks it: `net stop winnat; net start winnat` (elevated).
