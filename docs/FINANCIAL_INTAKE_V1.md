# Financial Intake V1 — conversational cost capture

**Purpose:** Design law and V1 scope for attaching maintenance spend to tickets through **natural language** (Propera-chat, SMS, WhatsApp, Telegram) — same friction model as ticket intake, not form-first finance.

**Audience:** product, engineering, next agent implementing capture.

**Related (do not duplicate):**

- [PROPERA_FINANCE_ROADMAP.md](./PROPERA_FINANCE_ROADMAP.md) — phased finance roadmap; dashboards come **after** capture is habitual.
- [PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md](./PROPERA_V2_APP_CAPABILITIES_AND_FINANCE_DEPTH.md) — what ships today (`ticket_cost_entries`, form UI, flags).
- [TICKET_TIMELINE.md](./TICKET_TIMELINE.md) — timeline duplicate rule; cost events use distinct `event_kind` values.

**North compass:** App is cockpit, not brain. Finance posting is deterministic DAL on top of operational anchors (tickets). Cost capture **never** reopens lifecycle or changes ticket status.

---

## Design law (product)

**Data entry friction is the product killer.** A system that can chart everything but requires manual receipt entry loses to a dumber system that captures automatically. Tickets won because capture fits the work motion. Finance must copy that rule:

> Every financial event must be capturable in the **same gesture** staff already make — or in one follow-up message with **pinned context**. No separate “go to finance tab and fill eight fields” step as the primary path.

**Phase 1 milestone (V1 bar):**

> A staff member can attach a cost to a ticket through Propera-chat (or typed marker on SMS/WA/Telegram) in **under ~10 seconds**, with or without a receipt photo.

Dashboards and portfolio lenses are **Phase 1.5+** on top of rows that actually exist.

**Scaffolding law (merge later):**

> Cost mode exists because intent detection is not ready yet. Every V1 choice should make the eventual merge with Lifecycle/Update **cheaper**, not more expensive — shared pin state, intent-shaped payloads, channel-agnostic markers, no Cost-only business rules that cannot be expressed as text.

---

## Design principle: Propera-chat is a signal source, not a separate product

**Propera-chat UI shortcuts are preset text.** The brain only sees the message body (plus canonical media package). Examples:

| In-app affordance | What the brain receives | Same on SMS/WA/Telegram |
|-------------------|-------------------------|-------------------------|
| **New ticket** pill | Message sent with leading `#` (staff capture) | Staff types `#apt 301 sink clogged` |
| **Lifecycle** pill | Plain text + optional ticket id appended | Staff types `306 penn done` |
| **Cost** pill (V1) | Message sent with leading `$$` (see syntax below) | Staff types `$$ apt 205 westgrand 33.40 homedepot duct vent` |

**Rule:** Every in-app affordance must compile to **text-only syntax** expressible on every channel. If it cannot be typed as text, it is either:

- **propera-chat-only presentation** (ticket cards, confirm pills, pinned UI), or
- **not V1** until a channel-neutral equivalent exists.

The brain route must be **intent-shaped**, not permanently mode-shaped:

```text
{
  intent: "expense_capture",
  sub_intent: "vendor_expense" | "tenant_chargeback",  // see split below
  payload: { amount_cents, entry_type, vendor_name, ticket_ref, ... },
  confidence: "high" | "medium" | "low",
  idempotency_key: "..."
}
```

Today: `portal_chat_mode` / pill = **preset intent** (classifier skipped).  
Later: untagged messages → classifier; tagged messages (`#`, `$$`) → explicit override.

**Transparency:** When the Cost pill prepends `$$`, the **user-visible chat line** must show the text actually sent (same mental model as seeing `#` after New ticket). Staff learn to type the marker without the pill.

---

## Locked decisions

### Q1 — Ticket search pool (cost ≠ lifecycle)

| Surface | Ticket universe |
|---------|-----------------|
| **Lifecycle** (`normal` mode) | **Open only** — unchanged (`filterLifecycleTicketsForUi` → `isTicketOpenForOps`). |
| **Cost** mode | **Open + recently closed** on same property + unit; explicit human ticket id **always** resolves regardless of status. |

**Why:** “Job done Friday, receipt Monday” is normal. Open-only cost search recreates the friction this project removes.

**Cost is a sidecar, not a state change:**

- Attaching cost to a **Completed** ticket does **not** reopen it.
- Ticket status unchanged; timeline gets a **cost** event (`cost_added` / `tenant_changed`-style semantics).
- Ops truth (lifecycle) and finance truth (spend rows) stay separate — same rule as PM assignment vs policy.

**Picker UX (propera-chat only):**

1. Section **Open** — same card shell as lifecycle.
2. Section **Recently completed** — default window **90 days** (`closedAt` / `createdAt`; tune in implementation).
3. **Find older** — one tap extends search (e.g. +180 days or all non-deleted for unit) — 90 days is not a hard wall.

**Brain:** Resolve ticket by pinned selection → single match in pool → explicit id in text → one clarifying question (never a form).

### Q2 — Third pill for V1 (scaffolding, not destination)

**V1:** Add a third mode pill — **Cost** — alongside **New ticket** and **Lifecycle**.

- Same conversational shell: pin property/unit, ticket cards, photo attach, confirm pills.
- Different: ticket filter, prepended marker, example chips, brain writer (`ticket_cost_entries`).

**Long-term arc:** One chat surface with intent detection (`done and 33.40 homedepot` in one message). **Merge trigger:** staff routinely send mixed-intent messages in either mode; then classifier earns its keep.

**Pinned context persists across mode switches:**

- Pin `westgrand apt 205` in Lifecycle → switch to Cost → **same pin** (property, unit, optional selected ticket).
- Required for: close ticket in Update → attach cost in Cost without retyping context.

**Same-day create + cost (V1 scope):**

| Part | V1 |
|------|-----|
| Create ticket (`#`) then switch to Cost with pin intact | **In** |
| Single message create + close + cost without mode switch | **Deferred** (needs multi-intent tag parsing; see mixed intent below) |
| Auto-close on create | **Out** |

**Card actions by mode (UI only, same ticket row):**

| Mode | Card affordances |
|------|------------------|
| Lifecycle | Status shortcuts (close, schedule, note, …) |
| Cost | Cost shortcuts: Parts, Labor, Material, Service call (maps to `entry_type` — see below) |

Same card component; different chip row — reinforces mode without new ticket types in Postgres.

**Pinned context (scope + TTL):**

| Rule | V1 default |
|------|------------|
| **Scope** | **Per staff session** in propera-chat (React state + optional sessionStorage). Not shared across users. SMS/WA/Telegram: last resolved property/unit/ticket on **that phone thread**. |
| **Carries across modes** | Property code, unit label, optional selected ticket id. |
| **Auto-clear** | **30 minutes** inactivity, explicit **Clear pin**, or new pin phrase for different property/unit. |
| **Survives** | Mode switch (Create ↔ Lifecycle ↔ Cost) until TTL/clear. |

---

## Cost classification (V1 — maps to DB)

NL parser and chips output a fixed set mapped to **`ticket_cost_entries.entry_type`** (migration 042 — lowercase in DB):

| Chat label / chip | `entry_type` | When to use |
|-------------------|--------------|-------------|
| **Parts** | `parts` | Physical part (duct vent, lock cylinder). |
| **Material** | `material` | Consumables / supplies. |
| **Labor** | `labor` | Handyman / staff labor. |
| **Service call** | `vendor_invoice` | Vendor visit, plumber/HVAC, invoice. |
| **Cleaning** | `cleaning` | Cleaning spend (parity with form). |
| **Permit** | `permit` | Permit fee. |
| **Other** | `other` | Escape valve. |

**One message = one cost row** in V1 (no multi-line receipt split).

---

## Vendor expense vs tenant chargeback

| `sub_intent` | V1 | Write path |
|--------------|-----|------------|
| **`vendor_expense`** | **In** | `createTicketCostEntryForPortal` → `ticket_cost_entries`; default `tenant_charge_status = not_chargeable`. |
| **`tenant_chargeback`** | **V1.1 defer** | Cost row + `tenant_charge_*` + `maybePostTicketChargeToLedger` when ledger flag on. |

Do **not** use chargeback in V1 cheat-sheet examples. V1 messages with “charge tenant …” → polite redirect to Costs panel or medium-tier block.

---

## Vendor resolution (V1)

| Situation | Behavior |
|-----------|----------|
| Catalog match | `vendor_name` snapshot (+ `vendor_id` when wired). |
| Fuzzy multiple | One clarifying question. |
| Hint, no match | Post with free-text `vendor_name`; **no auto-create vendor** in V1. |
| Missing | Allowed; may force **medium** confidence. |

---

## Text vs OCR (V1)

**Text wins.** OCR is evidence + confidence only. Amount mismatch (OCR vs text &gt; $0.01 or &gt; 2%) → drop confidence one tier; never post OCR amount over text without confirm.

---

## Cost marker syntax (channel-universal)

**Proposed V1 marker:** `$$` prefix (with trailing space before body), parallel to `#` for staff capture.

**Locked empty-state / cheat-sheet examples (UI + training — use verbatim):**

```text
$$ apt 205 westgrand 33.40 homedepot duct vent
$$ 33.40 dryer vent                    # ticket already pinned in app
$$ PENN-031225-1234 75 plumber callout # explicit ticket id
```

**Deferred example (V1.1 tenant chargeback):** `$$ charge tenant 75 broken blind`

**Disambiguation:** Bare `$` inside amounts is risky (`$33.40` literals). Require **leading** `$$` at message start (after trim) for cost intent — same discipline as leading `#` for capture.

**Alternatives if staff testing fails:** `+cost `, `cost:`, `/cost` — pick one canonical tag; document in staff cheat sheet.

**Mixed intent (post-V1, enabled by tags):**

```text
# apt 205 sink clogged $$ 33.40 homedepot part
```

Parse as sequential or compound intents when tag parser ships — not required for modal V1.

**Implementation notes:**

- propera-app: Cost pill prepends `$$ ` on send; show full outbound text in thread.
- V2: `portal_chat_mode: "cost"` may also set marker; inbound pipeline routes on **leading `$$`** OR mode hint (mode = preset for app).
- SMS/WA/Telegram: no cards — brain uses text + roster/ticket lookup same as portal.

---

## End-to-end flow (reference)

```text
Propera-chat / SMS / WA / Telegram
  → adapter (transport only — package in)
  → signal: body (+ optional media OCR hints)
  → tag / mode → intent: expense_capture
  → compile: sub_intent, amount, entry_type, vendor hint, description, ticket ref, receipt hints
  → idempotency check (below)
  → confidence gate (below)
  → createTicketCostEntryForPortal (existing DAL) — **same function as form UI**
  → timeline cost_added + optional ledger post
  → outgate reply (chat pill / SMS text)
```

**Reuse today:** `ticket_cost_entries`, `ticketCostEntries.js`, portal actor JWT, `enrichInboundMediaWithOcr` for photos, `staffTicketAmendNl` / `portalTicketMutations` as patterns — **new** `staffExpenseCaptureNl` (or equivalent) module, not a parallel finance app.

---

## Confidence-gated action (V1 policy)

**Style:** Rule-based with optional score 0.0–1.0 for telemetry. **Default policy: lean conservative — when in doubt, use medium, not high.**

| Confidence | Behavior |
|------------|----------|
| **High** | Post immediately; reply with summary + **Undo** hint. |
| **Medium** | Post only after **confirm pill** in propera-chat (SMS: reply YES / 1). |
| **Low** | One clarifying question in natural language — **never** open a multi-field form. |

**Rule-based floor (any one forces medium minimum):**

- Amount missing or ambiguous
- Ticket ambiguous (0 or 2+ matches, no pin, no id in text)
- Vendor unknown + no vendor text hint
- OCR amount mismatch vs text (see Text vs OCR)
- Chargeback phrases detected while sub_intent still V1 vendor-only (treat as medium + redirect message)

**High requires all:** pinned or single ticket match, explicit amount, sub_intent `vendor_expense`, no OCR amount conflict, not imported/deleted ticket.

Optional scoring for logs: start at 1.0, subtract 0.2 per bullet above; thresholds &gt;0.85 high, 0.6–0.85 medium, &lt;0.6 low.

---

## Idempotency (V1 — pre-decided)

Prevent duplicate rows when outgate fails and staff retries.

- **Key:** `hash(channel + source_message_id + normalized_body)` for portal; Twilio/Telegram message sid for SMS/WA.
- **DAL:** Before insert, check recent `ticket_cost_entries` (or `expense_capture_dedupe` event log) for same key within **24h**; return success with existing row id if duplicate.
- **Reply:** Same outgate text as first success (“Already recorded as $33.40 on #647”).

---

## Undo window (V1 — pre-decided)

- **Trigger:** Exact **`undo`** (case-insensitive) as the **whole** message, or leading `undo ` within the undo window — not “undo this please” (that is normal NL).
- **Target:** Voids the **last cost row posted in this chat thread** by this staff actor within the window.
- **Duration:** **60 seconds** after post, **or** until the user sends **any other** message in the thread (whichever comes first).
- **Mechanism:** Void flag on cost row + timeline note (prefer explicit `voided_at` over hard delete).
- **Out of V1:** Undo after navigate-away / cross-session; undo of non-last row.

---

## Receipt status (V1 — pre-decided)

Add first-class `receipt_status` on cost capture path (migration when implementing — not in 042 today).

| Value | Meaning |
|-------|---------|
| `PHOTO_ATTACHED` | Receipt image linked on row (`attachment_urls`). |
| `OFFICE_HOLDS_PHYSICAL` | No photo; office has paper (default when staff says so or no media). |
| `MISSING` | No receipt expected yet. |
| `RECONCILED` | Physical matched to row later (Phase 1.5 ops). |

Structured fields are truth; photo is **evidence**. No photo must **not** block capture.

---

## Blocked tickets (attach denied)

| Case | Policy |
|------|--------|
| **Imported history** | **Block** (same as other PM mutations). |
| **Soft-deleted / Deleted status** | **Block** with clear message. |
| **Voided / invalid** (admin: not a real issue) | **Block** — same as deleted when `status` or flag indicates non-work. |
| Cost on ticket later deleted | **Block ticket delete** when non-void `ticket_cost_entries` exist (V1). Orphan review queue = Phase 1.5. |

---

## Amount parsing (V1 scope)

| Input | V1 |
|-------|-----|
| `33.40`, `$33.40`, `33.40 homedepot` | **In** |
| `thirty three forty` (words) | **Out** — defer |
| `33,40` (comma decimal) | **Out** unless trivial locale rule added |
| `$33.40 + $5 tax` | **Explicit single amount only** — first money token or largest; no auto-sum |

---

## Feature flags and rollout

| Flag | Role |
|------|------|
| `PROPERA_FINANCE_ENABLED` + `PROPERA_FINANCE_TICKET_COSTS_ENABLED` | Master + ticket costs (existing). |
| **`PROPERA_FINANCE_COST_CAPTURE_CHAT`** (new) | Chat/marker expense capture. Off = form-only path unchanged. |
| **`NEXT_PUBLIC_PROPERA_FINANCE_COST_CAPTURE_CHAT`** | propera-app Cost pill + marker prepend. |

**Rollout:** Enable per **property_code** allowlist in env or DB config; pilot 1–2 properties; kill-switch reverts to `TicketCostsSection` only.

**Single write path:** Chat and form **must** call `createTicketCostEntryForPortal` (no parallel insert logic).

---

## Telemetry (V1)

Log (structured `appendEventLog` or metrics table) to make success criteria measurable:

| Event | Why |
|-------|-----|
| `EXPENSE_CAPTURE_ATTEMPT` | Funnel start (marker detected). |
| `EXPENSE_CAPTURE_POSTED` | Latency from attempt → post; `confidence`, `entry_type`, `sub_intent`. |
| `EXPENSE_CAPTURE_CONFIRMED` | Medium-tier confirm accepted. |
| `EXPENSE_CAPTURE_UNDO` | Undo rate by tier. |
| `EXPENSE_CAPTURE_IDEMPOTENT_HIT` | Duplicate suppressed. |
| `EXPENSE_CAPTURE_OCR_MISMATCH` | Text vs OCR amount conflict. |
| `EXPENSE_CAPTURE_SOURCE` | `pill` vs `typed_marker` vs `sms` / `telegram`. |

---

## What V1 includes / excludes

**In:**

- Cost mode pill + `$$` marker on all channels
- Pinned context across Create / Lifecycle / Cost
- Ticket picker: open + recent closed + find older
- NL parse → `ticket_cost_entries` write (`sub_intent: vendor_expense` only)
- Photo attach + OCR hints (text wins on conflict)
- Confidence tiers + undo + idempotency
- `receipt_status` column (migration)
- Chat outgate summary (amount, vendor, ticket total)
- Classification enum → existing `entry_type` values
- Per-property rollout flag

**Out (explicit defer — V1.1+):**

- **Tenant chargeback** from chat (`sub_intent: tenant_chargeback` + ledger post)
- Rent ledger, bank rec, vendor email inbox
- Full finance dashboard as Phase 1 goal
- Unified single-mode intent classifier
- Auto vendor invoice portal / auto-create vendor records
- Multi-intent single message (`#` + `$$` compound)
- Multi-line receipt split (one message → multiple cost rows)
- Word amounts, comma decimals, tax line summation

---

## propera-app touchpoints (implementation map)

| Area | File / area |
|------|-------------|
| Modes + marker prepend | `PortalCommandChat.tsx`, `/api/portal/command` |
| Lifecycle ticket filter | `portalChatLifecycle.ts` — **do not widen** for cost |
| Cost ticket filter | **new** `filterCostTicketsForUi` (open + recent closed) |
| Pinned context store | **new** shared pin state across modes |
| Form fallback | `TicketCostsSection.tsx` — keep for edge cases |
| Proxy | Existing ticket-cost-entries routes when finance flags on |

## propera-v2 touchpoints

| Area | File / area |
|------|-------------|
| Portal webhook | `buildRouterParameterFromPortal.js` — `portal_chat_mode: cost` |
| Inbound route | `runInboundPipeline.js` — expense branch |
| NL parser | **new** `staffExpenseCaptureNl.js` (pattern: `staffTicketAmendNl.js`) |
| Write | `ticketCostEntries.js` — `createTicketCostEntryForPortal` |
| OCR | `enrichInboundMediaWithOcr.js` |
| Tests | Scenario tests for marker, pin, completed ticket attach, no status change |

---

## Success metrics (V1)

- Median time from open Cost chat to confirmed post **&lt; 15s** (internal dogfood).
- **&gt; 70%** of new maintenance costs on pilot properties enter via chat/marker within 30 days (vs ticket panel form).
- Zero incidents of cost attach **changing** ticket status.
- Staff can attach cost to a ticket closed **&lt; 90 days ago** without support.

---

## Changelog

| Date | Note |
|------|------|
| 2026-05-19 | Initial design lock: Q1/Q2, channel-agnostic `$$` marker, scaffolding pills, pre-decisions for receipt_status / confidence / undo / delete. |
| 2026-05-19 | Pre-build review: `entry_type` taxonomy, vendor vs chargeback split (V1.1), vendor resolution, OCR rules, pin TTL, idempotency, undo semantics, voided tickets, telemetry, empty-state copy, feature flag, amount parsing deferrals, scaffolding law. |
