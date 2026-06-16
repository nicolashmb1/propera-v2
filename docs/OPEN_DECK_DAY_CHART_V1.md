# Open deck day chart — V1 (mobile)

**Status:** **Shipped (feature-flagged).** Dual-line chart at the bottom of the mobile **Open deck** on `/tickets`: **open snapshot** vs **completed cumulative** for one calendar day, **8am–8pm** display window, **day pager** (today and adjacent days).

**Scope:** **V2 tickets only** (Supabase). **GAS is out of scope** — no merge, no legacy rows.

---

## Purpose

Give PMs a **stock-style** view of the day: how **open inventory** moved hour by hour vs how many tickets were **completed today** (running total). Lives on the same screen as the open deck — quick situational awareness without opening Analytics.

---

## Locked product decisions (V1)

| Topic | Choice |
|-------|--------|
| Placement | **Mobile only**, bottom of **Open deck** (`listView === "deck"` on `propera-app/src/app/tickets/page.tsx`). Hidden on table view and desktop-wide layout (unless deck is shown). |
| Data source | **V2 only** — `public.tickets` + `public.ticket_timeline_events` (replay for open snapshots). No GAS. |
| Display window (x-axis) | **08:00–20:00** local ops time — **13 hourly points** (8 … 20 inclusive as hour **end** snapshots). |
| Calendar day (math) | **Midnight–midnight** in ops timezone for “today” totals; chart points only drawn for 8–20. |
| **Open** series | **Snapshot** at end of each hour: “how many non-terminal tickets were open at 8:00, 9:00, … 20:00?” Includes **carryover** from prior days (e.g. 10 open at 8am → first point is **10**, not 0). |
| **Completed** series | **Cumulative** for the calendar day: count of terminal completions with `closed_at` (or first terminal timeline event) **≤ end of that hour**. Includes pre-8am (e.g. resolved 7am → **8am point shows 1**). |
| After 8pm completions | **Footer line** under chart — not extra x-axis points. Example: `Today: 14 completed · 2 after 8pm`. Omit footer when zero after 8pm. |
| Future hours (today) | For hours **after “now”**, do not plot points (or show dashed/null) — only elapsed hours through current hour. |
| Day navigation | **Day pager** — default **today**; user can go **back** to prior days and **forward** to tomorrow / next calendar day. **No** TradingView infinite pan or pinch zoom in v1. |
| Future days | Allowed in pager; chart shows **empty / “No data yet”** or zero flat lines until that day exists. |
| Property scope | Respect deck filters: `?prop=` URL and staff property scope (same ticket set as open deck). |
| Timezone | **Single ops TZ** for v1 — `America/New_York` (configurable env later). All “today” and hour boundaries use this TZ. |
| Refresh | Reload with deck **pull-to-refresh** and ticket list fetch. |
| Library | **Recharts** (already in `propera-app`) — `LineChart`, two `Line`s, shared `XAxis`. |

---

## UX

### Layout (deck width)

```
┌─────────────────────────────────────┐
│  ←  Wed May 22  ·  Today  ·  Thu →  │  day pager
│  Open vs completed · 8a–8p          │
│  ── Open (snapshot)  ── Done (day)  │  legend
│  [ ~140–160px line chart ]          │
│  Today: 14 done · 2 after 8pm       │  footer (conditional)
└─────────────────────────────────────┘
```

- Card style: same horizontal inset as `.ticket-deck-group` (`margin: 0 12px`), border/radius aligned with `.ticket-deck-card`, slightly taller than one card.
- **Pager:** `←` / `→` or swipe on chart header; center label **Today** when `date === opsToday`, else short date (`Wed May 22`).
- **Loading / error:** skeleton in chart area; soft error “Chart unavailable” without breaking deck list.

### Tooltip (tap or hover)

`9:00 · Open: 25 · Completed today: 4`

### Empty states

| Case | UI |
|------|-----|
| No V2 tickets in scope for that day | “No ticket activity this day” |
| Future day | “This day hasn’t started yet” (or zero chart) |
| API error | Inline retry |

---

## API

### Route (planned)

```
GET /api/portal/tickets/day-curve
Authorization: Bearer <portal session JWT>
Query:
  date=YYYY-MM-DD          (required; ops TZ calendar date)
  propertyCode=PENN         (optional; omit = portfolio per staff scope)
```

**Gate:** Portal auth (same as other `/api/portal/*` reads).

### Response

```json
{
  "ok": true,
  "date": "2026-05-23",
  "timezone": "America/New_York",
  "displayWindow": { "startHour": 8, "endHour": 20 },
  "opsToday": "2026-05-23",
  "hours": [
    { "hour": 8,  "label": "8a",  "open": 10, "completedCumulative": 1,  "isFuture": false },
    { "hour": 9,  "label": "9a",  "open": 25, "completedCumulative": 2,  "isFuture": false },
    { "hour": 10, "label": "10a", "open": 12, "completedCumulative": 4,  "isFuture": false }
  ],
  "summary": {
    "completedTotal": 14,
    "completedAfterDisplayWindow": 2,
    "openNow": 18,
    "openAtDisplayStart": 10
  }
}
```

**Field rules:**

- `hours[]` — one row per integer hour **8..20**; always 13 entries for a full past day; for **today**, `isFuture: true` when hour end > now (client may hide point).
- `open` — non-terminal ticket count at **`date` + hour:59:59.999** (or start of next hour — pick one in implementation and test; document in code comment).
- `completedCumulative` — count terminal completions on **`date`** with `closed_at <=` that hour end (fallback: first `resolved_closed` / terminal `ticket_timeline_events.occurred_at` on that ticket for the day).
- `completedAfterDisplayWindow` — completions on `date` with `closed_at` **after 20:00** ops TZ → drives **footer**.
- `propertyCode` omitted: aggregate all properties the staff user may see (same allowlist as ticket list).

### `propera-app` API

```
GET /api/pm/tickets/day-curve?date=...&property=...
```

Reads **Supabase directly** (service role — same path as `/api/tickets`). Does **not** require V2/ngrok for the chart.

---

## Server computation (V2)

### Completed (cumulative)

1. Filter `tickets` where `property_code` in scope, not deleted, terminal status set.
2. `closed_at` on calendar `date` (ops TZ), or timeline terminal event if `closed_at` null.
3. For each hour `h` in 8..20: `completedCumulative[h] = count(closed_at <= endOfHour(h))`.
4. `completedAfterDisplayWindow = count(closed_at on date AND time > 20:00)`.
5. `completedTotal = count(all completions on date)`.

### Open (snapshot)

For each hour end `t` on `date`:

- Candidate tickets: `created_at <= t` and in property scope.
- **Open at `t`** if not terminal at `t`:
  - Prefer: replay `ticket_timeline_events` (status / resolved) with `occurred_at <= t`; default non-terminal if no terminal event yet.
  - Fallback v1: `closed_at is null OR closed_at > t` and current status non-terminal — **only if** timeline replay is too heavy; prefer replay for accuracy.

**Carryover:** Tickets open before midnight still count in 8am snapshot — no special case.

### Performance

- One SQL function or view parameterized by `date`, `property_code`, `tz`.
- Index use: `tickets(property_code, created_at)`, `tickets(closed_at)`, `ticket_timeline_events(ticket_id, occurred_at)`.
- If slow: cache per `(date, property_code)` for 60s in V2 memory (optional v1.1).

**No hourly snapshot table in v1** — replay only. Add `ticket_ops_hourly_snapshots` later if needed.

---

## Terminal statuses

Align with app open deck: `isTicketOpenForOps` / `isTerminalTicketStatus` in `propera-app/src/lib/ticketStatus.ts` — same list as `portal_dashboard_headlines_v1` (completed, canceled, resolved, closed, done, etc.).

---

## Code map (implementation checklist)

| Layer | Location |
|-------|----------|
| Spec | This file |
| SQL / RPC | `supabase/migrations/061_open_deck_day_chart_note.sql` (comment-only — no schema; computation is JS-only) |
| V2 service | `src/portal/ticketDayCurve.js` |
| V2 route | `src/portal/registerPortalRoutes.js` — `GET /api/portal/tickets/day-curve` |
| Tests | `tests/ticketDayCurve.test.js` — fixed fixtures: carryover open at 8am, 7am complete → 8am cumulative 1, after-8pm footer |
| App proxy | `propera-app/src/app/api/pm/tickets/day-curve/route.ts` |
| App component | `propera-app/src/components/OpenDeckDayChart.tsx` |
| Wire | `propera-app/src/app/tickets/page.tsx` — below `.ticket-deck-root` when `narrow && listView === "deck"` |
| API client | `getTicketDayCurve(date, property?)` in `lib/api.ts` |

**Guardrails:**

- Read-only analytics — no brain, no lifecycle, no ticket mutations.
- No GAS code paths.

---

## Acceptance criteria (V1 done)

- [x] Mobile open deck shows chart card under ticket groups (when flags on).
- [x] Default date = ops **today**; pager shows yesterday and tomorrow at minimum.
- [x] 8am open point reflects overnight carryover (not zero when 10 were already open).
- [x] 7am completion included in 8am completed cumulative point.
- [x] Completion at 9pm increments footer, not the 8–8 lines.
- [x] `?prop=` filters chart to that property.
- [x] Pull-to-refresh updates chart.
- [x] V2-only; no GAS references in API or UI copy.

**Enable:** `PROPERA_OPEN_DECK_DAY_CHART_ENABLED=1` (V2) + `NEXT_PUBLIC_PROPERA_OPEN_DECK_DAY_CHART_ENABLED=1` (propera-app). Restart both processes.

---

## Deferred

| Item | Notes |
|------|--------|
| Pinch zoom / TradingView continuous pan | Out of v1 |
| Per-property timezone | Single ops TZ |
| Hourly snapshot cron table | If replay too slow |
| Desktop deck chart | Mobile only v1 |
| Compare two properties on one chart | One scope per view |

---

## References

| Topic | Location |
|-------|----------|
| Open deck UI | `propera-app/src/app/tickets/page.tsx` |
| Open ticket definition | `propera-app/src/lib/ticketOpen.ts` |
| Dashboard aggregates pattern | `supabase/migrations/025_portal_dashboard_analytics_aggregates.sql`, `portalSupabaseDashboard.ts` |
| Timeline / terminal events | `docs/TICKET_TIMELINE.md` |
| Recharts examples | `propera-app/src/app/analytics/page.tsx` |

---

*When V1 ships: update **Status** here, append **`HANDOFF_LOG.md`**, and **`AGENTS.md`** “Where everything lives” row.*
