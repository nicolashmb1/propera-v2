# Structured logs (debugging with Cursor / LLMs)

## What you get

Every interesting step writes **one JSON object per line** to the server **terminal** (stdout). Same pattern as production log drains (Cloud Run, Datadog, etc.).

You can:

- **Filter one request:** copy lines that share the same `"trace_id"`.
- **Paste a block** into Cursor / ChatGPT / Claude — the model can follow `log_kind`, `event`, and `data` without parsing prose.

## Replay contract (any agent, any incident)

Logs are not only for developers — they are the **evidence bundle** when the brain does something unexpected. A single **`trace_id`** (plus, when needed, actor / ticket / WI ids inside `data`) should let **you or any agent** answer from the same paste:

- **Where it diverged** — which branch ran, at which layer, with which **`reason`** (not only *what* happened).
- **What was right vs wrong** — inputs and decision are both recorded; no “mystery” outcomes.
- **Stage truth** — was conversation / draft / WI in the **correct** expected stage for that turn (GAS-class `TURN_SUMMARY` parity in V2).
- **Policy** — what was evaluated, matched, or skipped (`POLICY_EVAL_*` style), and **why** a rule did not fire if that matters.
- **Outbound** — message sent, or **not sent** with an explicit **skip reason** (compliance gate, empty reply, outbound disabled, dedupe, lane blocked core, etc.). *Silence without a log line is a bug.*

**Implementation bar:** Anything that changes user-visible behavior or could explain a support ticket **must** leave a structured line: **`event` + `reason` + minimal context**. Plumbing-only steps can stay quiet; **“no message sent”** never should be quiet.

**Brain (core) examples:** `EXPECT_RECOMPUTED` (draft slot flags + next stage), `TURN_SUMMARY` (lane/stage path), `CORE_FAST_PATH_COMPLETE` (single-message parse), `CORE_FINALIZED` — see `handleInboundCore.js` + `appendEventLog` / `emit` pairs.

---

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

Table `event_log` is created in `002_event_log.sql`. Inserts via `appendEventLog` (`src/dal/appendEventLog.js`) run for some brain steps (e.g. `LANE_DECIDED`, core `CORE_*`) when Supabase is configured. **Many adapter/router lines still only go to stdout** via `emit` — see *GAS parity* below for the goal: same event should be queryable in DB *and* visible in the terminal with one shape.

---

## GAS “log sheet” vs V2 (why the old rows looked like snapshots)

The legacy Sheet was **not** storing database snapshots in the SQL sense. Each row was an **append-only decision journal**: one **tag** (event name) plus a **payload string** (often `key=[value]` pairs). Reading down the sheet for one phone/thread is a **flight recorder** of *what happened* and *why the brain moved*.

### What the tags were doing (grouped)

| Area | Example tags | Role |
|------|----------------|------|
| **Inbound identity** | `DOPOST_HIT`, `SIM_GATE_DEBUG`, `DEDUP_RESULT` | Request hit, simulator gate, idempotency (`sid`, `trace`, `inboundKey`) |
| **Router** | `ROUTER_IN`, `ROUTER_LANE`, `ROUTER_CTX`, `ROUTER_BRANCH`, `ROUTER_PENDING_OVERRIDE` | Normalized text, lane (TENANT/STAFF), session context (`exp=` expected stage, active WI) |
| **Staff** | `STAFF_CHECK` | Directory lookup flags (`isStaff`, lifecycle on) |
| **Core / compile** | `CORE_SEES`, `COMPILE_TURN`, `COMPILE_EMERGENCY`, `EMERGENCY_EVAL` | What core is allowed to see; draft slots filled; emergency path |
| **Domain / location** | `LOCATION_SCOPE_INFERRED`, `DOMAIN_SIGNAL_BUILT`, `DOMAIN_SLOT_SCORE`, `DOMAIN_ROUTE_SELECTED` | Scoring MAINTENANCE vs CLEANING, confidence, reasons |
| **Session / draft** | `SESSION_UPSERT`, `DRAFT_UPSERT`, `ISSUE_WRITE`, `DAL_WRITE` | Sheet/session writes and *why* (`reason=[draftUpsertFromTurn_issue]`) |
| **Stage resolution** | `EXPECT_RECOMPUTED`, `RECOMPUTE_ENTRY`, `SESSION_RELOAD_BEFORE_RESOLVER` | **Draft completeness** → next expected slot (PROPERTY → UNIT → …) |
| **The “snapshots”** | `TURN_SUMMARY`, `STATE_RESOLVED`, `STAGE_DECISION` | **One-line state snapshot**: lane, mode, `stage`, `expected`, `replyKey` — *this* is how you answered “why did it ask for property?” |
| **Outgate** | `OUTBOUND_INTENT_EMIT`, `OUT_SMS`, `OUTGATE_TEMPLATE_SOURCE` | Intent type, template key, channel, body length (not always full text in log) |
| **Finalize / ticket** | `FINALIZE_DRAFT_ENTER`, `PT_00`…`PT_99`, `TICKET_CREATE`, `FINALIZE_DRAFT_OK` | Phased finalize with clear boundaries; ticket id + row |
| **Post-create** | `SR_RESOLVED`, `POLICY_EVAL_*`, `TRACE_LIFECYCLE_*`, `SCHED_SYNC_*`, `WI_WAIT_TENANT` | Resolver, policy, lifecycle timing, schedule column sync |

So: **“snapshots”** in your paste are mostly **`TURN_SUMMARY` / `STATE_RESOLVED` / `STAGE_DECISION`** — they record **brain state after a turn**, not a DB dump.

### V2 equivalent (target shape)

Use the **same mental model**, with **structured JSON** instead of a free-text column:

| Concept | GAS sheet | V2 |
|--------|-----------|-----|
| Correlate one inbound | `sid=` / `trace=` / `eid=` | **`trace_id`** (HTTP) + **`update_id`** or future **`inbound_key`** in `data` / `payload` |
| Layer | First column after body ≈ tag | **`log_kind`** (`telegram_adapter`, `router`, `brain`, `core`, `outgate`, …) |
| Event name | Tag (`ROUTER_LANE`, …) | **`event`** (stable string; prefer **same names as GAS** where behavior matches) |
| Why + parameters | Rest of row | **`data` / `payload` object** — always include **`reason`** when a branch is taken |

**Query story:** Filter `event_log` (or grep stdout) by `trace_id` to replay one webhook; filter by `actor` / `ticket_key` / `work_item_id` once those are added to payloads as the brain grows.

### Parity checklist (as the brain is ported)

Keep this list aligned with [BRAIN_PORT_MAP.md](./BRAIN_PORT_MAP.md); do **not** invent parallel “debug-only” branches — log the **real** resolver/lifecycle decisions.

1. **Every major branch** logs **`event` + `reason` + inputs** (precursor outcome, lane, compile output, stage transition).
2. **State snapshots** (GAS `TURN_SUMMARY` class) map to a single JSON object: `stage`, `expected`, `reply_key` / `intent_type`, `active_work_item_id`, `draft` pointers as applicable.
3. **Side effects** (ticket create, session upsert, WI update) log **before/after ids** and **idempotency key** where GAS used `inboundKey`.
4. **Stdout + DB:** Prefer **`emit` + optional `appendEventLog`** with the same payload so local dev without DB still sees the full story; when `event_log` is enabled, operators can query history.
5. **PII:** Same discipline as GAS — truncate bodies in stored payloads if policy requires; full text can stay terminal-only in dev.

### Current V2 coverage

- **Present:** Telegram normalize, dedupe, router lane (`emit` + `LANE_DECIDED` in `event_log`), core milestones (`CORE_*` in `event_log` from `handleInboundCore`), outbound send logs.
- **Not yet:** `COMPILE_TURN`, `EXPECT_RECOMPUTED`, `TURN_SUMMARY`, finalize phases, policy/lifecycle — add **`event` names and `payload` fields** as those modules land, reusing the GAS vocabulary where it matches behavior.
