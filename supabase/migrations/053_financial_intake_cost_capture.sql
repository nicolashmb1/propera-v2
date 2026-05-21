-- Financial Intake V1 — chat/marker cost capture columns on ticket_cost_entries.
-- @see docs/FINANCIAL_INTAKE_V1.md

alter table public.ticket_cost_entries
  add column if not exists receipt_status text not null default 'MISSING',
  add column if not exists voided_at timestamptz,
  add column if not exists capture_idempotency_key text;

alter table public.ticket_cost_entries
  drop constraint if exists ticket_cost_entries_receipt_status_chk;

alter table public.ticket_cost_entries
  add constraint ticket_cost_entries_receipt_status_chk check (
    receipt_status in ('PHOTO_ATTACHED', 'OFFICE_HOLDS_PHYSICAL', 'MISSING', 'RECONCILED')
  );

comment on column public.ticket_cost_entries.receipt_status is
  'Receipt evidence state for chat capture (FINANCIAL_INTAKE_V1).';

comment on column public.ticket_cost_entries.voided_at is
  'Set when staff undoes a chat-posted cost within the undo window.';

comment on column public.ticket_cost_entries.capture_idempotency_key is
  'Dedupe key: channel + message id + normalized body hash (24h window in app).';

create unique index if not exists ticket_cost_entries_capture_idempotency_uq
  on public.ticket_cost_entries (capture_idempotency_key)
  where capture_idempotency_key is not null and voided_at is null;

create index if not exists ticket_cost_entries_ticket_voided_idx
  on public.ticket_cost_entries (ticket_id, voided_at);
