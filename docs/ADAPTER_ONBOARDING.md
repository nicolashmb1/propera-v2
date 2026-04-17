# Adapter Onboarding (Channel-Agnostic Contract)

Use this when adding a new inbound channel (SMS, WhatsApp, Alexa, Meta glasses, etc.).

**Non-negotiable rule:** adapters are transport-only.  
Do not add business logic in adapter code. Route all behavior through the existing core path.

---

## 1) Read before coding

1. `../AGENTS.md`
2. `./PARITY_LEDGER.md`
3. `./PORTING_FROM_GAS.md`
4. `./BRAIN_PORT_MAP.md`
5. `../../PROPERA_GUARDRAILS.md`

If any of these conflict with a proposed change, stop and keep parity/guardrails.

---

## 2) Required contract (must match existing flow)

Every adapter must produce:

- `InboundSignal` via `src/signal/inboundSignal.js`
- `RouterParameter` contract fields used by router/core:
  - `From`
  - `Body`
  - `_channel`
  - `_phoneE164`
  - `_mediaJson` (JSON string array; `""` when absent)
  - channel-specific transport ids (e.g. message/update id)

**Core invariant:** `index.js` should continue running the same pipeline:

`normalize -> contract build -> router precursor/lane -> core -> outbound`

No channel-specific branching in lifecycle/policy/core logic.

---

## 3) Adapter implementation checklist

Create adapter-specific files only:

- `src/adapters/<channel>/verifyWebhook...`
- `src/adapters/<channel>/normalize...`
- `src/contracts/buildRouterParameterFrom<Channel>.js`
- optional outbound transport in `src/outbound/`

Then wire in `src/index.js`:

- add channel webhook endpoint
- run same pipeline used by Telegram path
- keep logs/tracing aligned with existing keys

Do not modify:

- `src/brain/core/handleInboundCore.js` for channel-specific behavior
- lifecycle/policy modules for transport-specific rules

---

## 4) Media + OCR contract

Media is shared infrastructure, not channel logic.

- `_mediaJson` is the adapter-to-core bridge
- parse with `src/brain/shared/mediaPayload.js`
- optional OCR enrichment must write `ocr_text` in media items
- OCR orchestrator should stay channel-agnostic (`src/brain/shared/mediaOcr.js`)
- adapter-specific OCR producer hooks are allowed, but must only enrich media payloads

---

## 5) Parity gates before merge

Minimum tests:

- adapter normalize tests
- contract build tests (`_mediaJson`, actor ids, body/caption/text)
- router normalization tests for channel shape
- `npm test` full pass

Do not claim parity until `docs/PARITY_LEDGER.md` row is updated with status/risk.

---

## 6) Docs you must update in same PR

- `docs/PARITY_LEDGER.md` (status + semantic gaps)
- `docs/BRAIN_PORT_MAP.md` (flow/wiring updates)
- `docs/PORTING_FROM_GAS.md` (mapping row if new GAS-owned behavior touched)
- `docs/HANDOFF_LOG.md` (dated entry)
- `README.md` (new route/env/start steps if needed)
- `docs/OUTSIDE_CURSOR.md` (operator steps for webhooks/secrets)

Rule: stale docs are a bug.

---

## 7) Definition of done for a new channel

- Adapter produces canonical contract
- Core behavior unchanged (same brain decisions for same signal)
- Media bridge works with `_mediaJson`
- Tests pass
- Ledger and handoff docs reflect truth

