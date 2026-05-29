# Access scenario fixtures

These JSON files are the **regression gate** for the access engine. Each
fixture is one full tenant conversation; the harness in
[`../runScenario.js`](../runScenario.js) replays it through the real
agent → brain seam with mocks installed for the LLM, wall clock, and
Supabase.

If a code change breaks any fixture, that change is breaking real,
already-shipped behavior — fix the change, do not weaken the fixture.

## When to add a fixture

Add a new fixture when:

1. A bug ships to a tenant and you need a regression test that
   *describes the conversation as a tenant would experience it.*
2. You add a new conversational behavior (closure, lane switch, multi-day
   booking, etc.).
3. The 4 root-cause categories in `PROPERA_NORTH_COMPASS.md` change —
   each new "kind of fact the brain decides" deserves at least one
   fixture.

Do **not** add fixtures for low-level parsing or DB unit tests — those
belong in the focused test files (`tests/access/dayResolver.test.js`,
`tests/access/amenityResolver.test.js`, etc.).

## Fixture shape

```jsonc
{
  "name": "reserve_happy_path",
  "description": "Tenant books Game Room Sunday 10am-1pm.",

  // ISO instant — controls `new Date()` everywhere (DST-safe; the
  // dayResolver still computes correct local labels because it uses
  // the real Intl API on top of the frozen clock).
  "frozenNow": "2026-05-27T18:00:00.000Z",

  // PROPERA_TZ for this scenario. Defaults to America/New_York.
  "timezone": "America/New_York",

  "tenant": {
    "tenantId": "11111111-1111-1111-1111-111111111111",
    "propertyCode": "PENN",
    "unitLabel": "502",
    "residentName": "Nicolas",
    "phoneE164": "+15551234001",
    "transportChannel": "sms"
  },

  "amenities": [
    {
      "id": "22222222-2222-2222-2222-222222222222",
      "slug": "game-room",
      "name": "Game Room",
      "propertyCode": "PENN",
      "active": true
    }
  ],

  "initialReservations": [], // Optional pre-seeded bookings.

  "turns": [
    {
      // What the tenant texts on this turn.
      "userMessage": "i want to book the game room sunday 10am to 1pm",

      // Scripted LLM response. ISO times here are wall-clock-local with a
      // trailing Z (this matches the LLM contract — see
      // `reinterpretLlmUtcIsoAsLocalWallClock`).
      "llm": {
        "ok": true,
        "reply": "Got it — booking game room Sunday 10am to 1pm.",
        "accessIntent": "reserve",
        "partialUpdates": {
          "location_slug": "game-room",
          "date_for_day": "sunday",
          "start_at": "2026-05-31T10:00:00Z",
          "end_at": "2026-05-31T13:00:00Z"
        },
        "handoffReady": true
      },

      // What the tenant should see / what the system state should be.
      // All fields are optional; any provided field is asserted.
      "expect": {
        "phase": "access_handoff",      // maybeHandleAccessTurn return.phase
        "brain": "access_reserved",     // handleAccessInbound return.brain
        "replyContains": "Booked",      // substring (case-insensitive)
        "replyMatches": "PIN: \\d{4}",  // optional regex
        "kickbackIntent": null,         // for needs_more / kickback turns
        "lane": "access",               // conversation._active_lane
        "hasLastBooking": true,         // _access_last_booking set
        "reservationsCount": 1,         // total bookings in the stub
        "activeReservationsCount": 1    // CONFIRMED + PENDING_APPROVAL + ACTIVE
      }
    }
  ]
}
```

## What this harness does NOT cover

The scenario harness drives the **agent → brain seam** directly:

```
maybeHandleAccessTurn  →  handleAccessInbound  →  recordTenantAgentAccessResult
```

It does **not** invoke `dispatchByActiveLane` (the per-turn lane router that
runs one layer above `maybeHandleAccessTurn` in production). Concretely, the
following behaviors are out of scope for these fixtures and must be tested
with focused unit tests under `tests/tenantAgent/`:

* **Always-on deterministic maintenance interrupt.** When the access lane
  is sticky from a previous turn and the new inbound contains a strong
  maintenance signal (`sink + drip`, `i need maintenance`, `service request`,
  etc.), `dispatchByActiveLane` clears the lane and falls through to the
  maintenance gather — *regardless of whether the LLM was about to emit
  `access_intent: "switch_maintenance"`*. The LLM is interpretation; the
  lane switch is control. See
  [`tests/tenantAgent/dispatchMaintenanceInterrupt.test.js`](../../../tenantAgent/dispatchMaintenanceInterrupt.test.js).

* **Lane close on bare "thanks" / "all set" / "never mind"** when the LLM
  is unavailable.

When/if the harness is extended to drive through `dispatchByActiveLane`,
move those behaviors into JSON fixtures and delete the corresponding unit
tests.

## Notes / gotchas

* **`llm` is required on every turn that the LLM would be invoked on.**
  If a turn has `llm: null` (or omits it) and the LLM is called, the
  harness fails loudly — silent regressions can't sneak past.
* **`lockedLane: true`** on a turn forces routing into the access lane
  even when the body text wouldn't otherwise match the access router.
  Use this for turns that come *after* the lane has been opened (e.g.
  a one-word "saturday" reply that wouldn't trigger access routing on
  its own).
* **Times in `llm.partialUpdates`** are written as `YYYY-MM-DDTHH:MM:00Z`
  but reinterpreted as wall-clock local — `10:00:00Z` means 10 AM in the
  property's timezone, not 10 AM UTC.
* **`injectPayload`** on a turn short-circuits the agent gather gate and
  feeds a hand-crafted handoff payload straight into the brain. Use only
  for testing the handoff-schema kickback paths (Piece 1) — the agent
  gate already refuses malformed payloads in normal flow, so direct
  injection is the only way to exercise the schema validator from a
  scenario test.
