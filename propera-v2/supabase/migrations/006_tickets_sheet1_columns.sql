-- Sheet1 / COL parity — extend public.tickets to match 01_PROPERA MAIN.gs COL (55 columns).
-- Run after 001_core.sql. Safe to re-run: IF NOT EXISTS on each column.
-- Types: mostly text to match Sheets "Yes"/"No"/empty; timestamps where the sheet stores dates.

-- Already in 001: id, ticket_id, tenant_phone_e164, property_code, unit_label, message_raw,
-- category, status, ticket_key, sheet_row_legacy, created_at, updated_at

-- --- COL 1–15 (sheet order per COL comment) ---
alter table public.tickets
  add column if not exists timestamp_logged_at timestamptz,
  add column if not exists property_display_name text default '',
  add column if not exists emergency text default '',
  add column if not exists emergency_type text default '',
  add column if not exists urgency text default '',
  add column if not exists urgency_reason text default '',
  add column if not exists confidence numeric,
  add column if not exists next_question text default '',
  add column if not exists auto_reply text default '',
  add column if not exists escalated_to_you text default '',
  add column if not exists thread_id text default '';

comment on column public.tickets.timestamp_logged_at is 'GAS COL.TS — sheet row timestamp (may differ from created_at)';
comment on column public.tickets.property_display_name is 'GAS COL.PROPERTY — display e.g. The Grand at Murray';
comment on column public.tickets.thread_id is 'GAS COL.THREAD_ID — e.g. STAFFCAP:…';

-- --- COL 16–22 ---
alter table public.tickets
  add column if not exists assign_to text default '',
  add column if not exists due_by timestamptz,
  add column if not exists last_activity_at timestamptz,
  add column if not exists preferred_window text default '',
  add column if not exists handoff_sent text default '';

comment on column public.tickets.last_activity_at is 'GAS COL.LAST_UPDATE — LastUpdatedAt on sheet';

-- --- COL 23–28 ---
alter table public.tickets
  add column if not exists category_final text default '', -- legacy AppSheet; see 007 comment
  add column if not exists priority text default '',
  add column if not exists service_notes text default '',
  add column if not exists closed_at timestamptz,
  add column if not exists attachments text default '';

comment on column public.tickets.attachments is 'GAS COL.ATTACHMENTS — URLs (often Drive), pipe- or newline-separated';

-- --- COL 29–35 SMS / messaging flags ---
alter table public.tickets
  add column if not exists completed_msg_sent text default '',
  add column if not exists completed_msg_sent_at timestamptz,
  add column if not exists created_msg_sent text default '',
  add column if not exists created_msg_sent_at timestamptz,
  add column if not exists created_by_manager text default '',
  add column if not exists cancel_msg_sent text default '',
  add column if not exists cancel_msg_sent_at timestamptz;

-- --- COL 36–42 identity / routing ---
alter table public.tickets
  add column if not exists legacy_property_id text default '',
  add column if not exists legacy_unit_id text default '',
  add column if not exists location_type text default '',
  add column if not exists work_type text default '',
  add column if not exists resident_id text default '',
  add column if not exists unit_issue_count text default '',
  add column if not exists target_property_id text default '';

comment on column public.tickets.legacy_property_id is 'GAS COL.PROPERTY_ID — e.g. PROP_* or sheet id';
comment on column public.tickets.legacy_unit_id is 'GAS COL.UNIT_ID';

-- --- COL 43–50 assignment & vendor ---
alter table public.tickets
  add column if not exists assigned_type text default '',
  add column if not exists assigned_id text default '',
  add column if not exists assigned_name text default '',
  add column if not exists assigned_at timestamptz,
  add column if not exists assigned_by text default '',
  add column if not exists vendor_status text default '',
  add column if not exists vendor_appt text default '',
  add column if not exists vendor_notes text default '';

-- ticket_key already exists in 001

-- --- COL 52–55 ---
alter table public.tickets
  add column if not exists visit_id text default '',
  add column if not exists owner_action text default '',
  add column if not exists owner_action_at timestamptz,
  add column if not exists scheduled_end_at timestamptz;

comment on column public.tickets.visit_id is 'GAS COL.VISIT_ID — links Visits sheet';
comment on column public.tickets.scheduled_end_at is 'GAS COL.SCHEDULED_END_AT — parsed schedule end';

-- Helpful indexes for portal / filters (safe if already present)
create index if not exists tickets_status_idx on public.tickets (status);
create index if not exists tickets_assigned_id_idx on public.tickets (assigned_id)
  where assigned_id is not null and assigned_id <> '';
create index if not exists tickets_thread_id_idx on public.tickets (thread_id)
  where thread_id is not null and thread_id <> '';
