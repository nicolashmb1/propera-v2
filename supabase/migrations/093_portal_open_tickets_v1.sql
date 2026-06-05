-- Open-ticket projection of portal_tickets_v1 for Jarvis operational scope.
--
-- Why: scope reads (`listOpenTicketsForProperty`, `listAllOpenServiceTickets`)
-- fetched a LIMIT window from portal_tickets_v1 and filtered "open" in JS. At a
-- busy property/portfolio, recently-updated *closed* rows could fill the window
-- and push genuinely-open tickets out of view (a correctness bug), and the
-- portfolio list overfetched 4× to compensate. Pushing the case-insensitive
-- open filter into SQL fixes both: every returned row is open, no overfetch.
--
-- Thin wrapper (does NOT redefine the heavily-used base view). Casing is
-- normalized here exactly like the JS CLOSED_STATUSES set. Safe re-run.
--
-- JS caller falls back to base view + JS filter if this view is absent, so it is
-- safe to deploy code ahead of this migration.

create or replace view public.portal_open_tickets_v1 as
select *
from public.portal_tickets_v1
where lower(trim(coalesce(status, ''))) not in (
  'completed',
  'canceled',
  'cancelled',
  'resolved',
  'closed',
  'done',
  'deleted'
);

comment on view public.portal_open_tickets_v1 is
  'Open-only projection of portal_tickets_v1 (excludes completed/canceled/resolved/closed/done/deleted). Used by Jarvis operational scope so LIMIT windows cannot drop open tickets.';
