# Common Area Policy (V2)

This document freezes the agreed policy for COMMON_AREA maintenance behavior.

## Deterministic hints

V2 `inferLocationTypeFromText` (`src/brain/shared/commonArea.js`) matches phrases such as **common area**, hallways, **gym**, **fitness center**, clubhouse, **pool deck**, etc., so staff `#amenity` lines can finalize as COMMON_AREA without a unit when those words appear in the issue text.

## Target Rules

- Tenant common-area report creates a ticket with:
  - `location_type = COMMON_AREA`
  - empty `unit_label`
  - empty `tenant_phone_e164`
- Ticket body keeps context in `message_raw` when available:
  - `Report from apt X Phone: Y`
  - followed by issue text.
- COMMON_AREA tickets do not enter tenant schedule-ask flow.
- `#` staff capture allows COMMON_AREA finalization without requiring unit.

## Scope Guard

- These rules apply only to maintenance tickets classified as `COMMON_AREA`.
- Unit tickets keep current behavior (unit required, tenant phone persisted, schedule flow unchanged).
