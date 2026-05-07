-- Example: promote one import batch from staging → public.tickets (historical only).
-- CUSTOMIZE column expressions to match your row_json export keys before running.
-- Supabase: replace ALL __IMPORT_BATCH_ID__ with your batch id (keep quotes).

begin;

insert into public.tickets (
  ticket_id,
  tenant_phone_e164,
  property_code,
  property_display_name,
  unit_label,
  message_raw,
  category,
  category_final,
  status,
  priority,
  service_notes,
  preferred_window,
  assign_to,
  assigned_name,
  attachments,
  closed_at,
  created_at,
  updated_at,
  ticket_key,
  source_system,
  source_ticket_id,
  source_row_hash,
  imported_at,
  import_batch_id,
  is_imported_history
)
select
  coalesce(nullif(trim(s.row_json->>'ticket_id'), ''), nullif(trim(s.row_json->>'ticketId'), '')),
  coalesce(nullif(trim(s.row_json->>'tenant_phone_e164'), ''), ''),
  upper(trim(coalesce(s.row_json->>'property_code', s.row_json->>'PROPERTY_CODE', ''))),
  trim(coalesce(s.row_json->>'property_display_name', s.row_json->>'PROPERTY', '')),
  trim(coalesce(s.row_json->>'unit_label', s.row_json->>'UNIT', '')),
  trim(coalesce(s.row_json->>'message_raw', s.row_json->>'MESSAGE', s.row_json->>'issue', '')),
  trim(coalesce(s.row_json->>'category', '')),
  trim(coalesce(s.row_json->>'category_final', '')),
  trim(coalesce(s.row_json->>'status', s.row_json->>'STATUS', '')),
  lower(trim(coalesce(nullif(s.row_json->>'priority', ''), 'normal'))),
  trim(coalesce(s.row_json->>'service_notes', '')),
  trim(coalesce(s.row_json->>'preferred_window', '')),
  trim(coalesce(s.row_json->>'assign_to', '')),
  trim(coalesce(s.row_json->>'assigned_name', '')),
  trim(coalesce(s.row_json->>'attachments', '')),
  (s.row_json->>'closed_at')::timestamptz,
  coalesce((s.row_json->>'created_at')::timestamptz, now()),
  coalesce((s.row_json->>'updated_at')::timestamptz, now()),
  coalesce(nullif(trim(s.row_json->>'ticket_key'), ''), ''),
  'gas_sheet1',
  coalesce(nullif(trim(s.row_json->>'ticket_id'), ''), nullif(trim(s.row_json->>'ticketId'), '')),
  encode(
    digest(
      trim('__IMPORT_BATCH_ID__') || '|' || coalesce(s.sheet_row::text, s.id::text) || '|' || s.row_json::text,
      'sha256'
    ),
    'hex'
  ),
  now(),
  trim('__IMPORT_BATCH_ID__'),
  true
from public.gas_sheet1_ticket_import_staging s
where s.import_batch_id = trim('__IMPORT_BATCH_ID__')
on conflict (ticket_id) do update set
  updated_at = excluded.updated_at,
  attachments = excluded.attachments,
  service_notes = excluded.service_notes,
  closed_at = excluded.closed_at,
  status = excluded.status
where coalesce(public.tickets.is_imported_history, false) = true;

commit;
