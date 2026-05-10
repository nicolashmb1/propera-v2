-- Normalize event_kind if an older draft of 034 used shorter names (safe no-op when empty).

update public.ticket_timeline_events
set event_kind = 'vendor_eta'
where event_kind = 'eta';

update public.ticket_timeline_events
set event_kind = 'scheduled'
where event_kind = 'schedule';

update public.ticket_timeline_events
set event_kind = 'resolved_closed'
where event_kind = 'status'
  and trim(headline) = 'Ticket resolved or closed';

update public.ticket_timeline_events
set event_kind = 'status_changed'
where event_kind = 'status';
