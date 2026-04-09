# Structured logs (debugging with Cursor / LLMs)

## What you get

Every interesting step writes **one JSON object per line** to the server **terminal** (stdout). Same pattern as production log drains (Cloud Run, Datadog, etc.).

You can:

- **Filter one request:** copy lines that share the same `"trace_id"`.
- **Paste a block** into Cursor / ChatGPT / Claude — the model can follow `log_kind`, `event`, and `data` without parsing prose.

## Shape (common fields)

| Field | Meaning |
|-------|---------|
| `ts` | ISO timestamp |
| `service` | Always `propera-v2` |
| `level` | `info`, `error`, … |
| `trace_id` | UUID for this HTTP request (also returned as header `X-Trace-Id`) |
| `log_kind` | `http_request`, `boot`, `trace_step`, `trace_snap`, `trace_decision`, `trace_error`, `trace_perf`, … |
| `event` | Short label (e.g. `HEALTH`, `GET /health`) |
| `data` | Object with details (paths, DB ping result, timing) |

## Example lines

```json
{"ts":"2026-04-08T22:00:00.000Z","service":"propera-v2","level":"info","trace_id":null,"log_kind":"boot","event":"listen","data":{"port":8080,"nodeEnv":"development"}}
{"ts":"2026-04-08T22:00:01.000Z","service":"propera-v2","level":"info","trace_id":"abc-123","log_kind":"http_request","event":"GET /health","data":{"method":"GET","path":"/health"}}
```

## Disable

Set `STRUCTURED_LOG=0` in `.env` (rarely needed).

## Database (optional, next)

Table `event_log` is created in `002_event_log.sql`. Wiring inserts from Node is optional — **stdout stays the source of truth** for local debugging until we add `LOG_TO_SUPABASE`.
