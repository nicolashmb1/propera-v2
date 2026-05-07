-- Ops only: inspect pending lifecycle timers that are past due but tied to terminal work items/tickets.
-- Safe to run in SQL Editor (read-only SELECT). Review results before any UPDATE.
--
-- V2 now cancels pending timers when work items/tickets reach terminal states via normal paths.
-- Use this to clean up rows created before that behavior or from unusual paths.

SELECT
  lt.id,
  lt.work_item_id,
  lt.timer_type,
  lt.run_at,
  lt.status AS timer_status,
  wi.status AS work_item_status,
  wi.state AS work_item_state,
  t.ticket_id,
  t.status AS ticket_status
FROM public.lifecycle_timers lt
LEFT JOIN public.work_items wi
  ON wi.work_item_id = lt.work_item_id
LEFT JOIN public.tickets t
  ON t.ticket_key = wi.ticket_key
WHERE lt.status = 'pending'
  AND lt.run_at <= now()
  AND (
    upper(coalesce(wi.status, '')) IN ('COMPLETED', 'CANCELED', 'CANCELLED')
    OR upper(coalesce(wi.state, '')) = 'DONE'
    OR lower(coalesce(t.status, '')) IN (
      'completed', 'deleted', 'canceled', 'cancelled', 'closed', 'done'
    )
  );

-- Optional cleanup (DANGEROUS if mis-scoped — run only after validating the SELECT above):
-- UPDATE public.lifecycle_timers lt
-- SET
--   status = 'cancelled',
--   payload = coalesce(lt.payload, '{}'::jsonb)
--     || jsonb_build_object(
--       'cancel_reason', 'ops_bulk_terminal_cleanup',
--       'cancelled_at', to_jsonb(now())
--     )
-- WHERE lt.id IN ( ... paste ids from SELECT ... );
