-- Vendor lane V0/V1: dispatch contacts, conversation ctx, dispatch idempotency on tickets.
-- @see docs/VENDOR_LANE.md

-- ---------------------------------------------------------------------------
-- vendor_contacts — phone identity for lane + dispatch SMS
-- ---------------------------------------------------------------------------
create table if not exists public.vendor_contacts (
  id uuid primary key default gen_random_uuid(),
  vendor_id text not null references public.vendors (vendor_id) on delete cascade,
  phone_e164 text not null default '',
  role text not null default 'dispatch',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendor_contacts_vendor_id_idx
  on public.vendor_contacts (vendor_id);

create index if not exists vendor_contacts_active_idx
  on public.vendor_contacts (active) where active = true;

comment on table public.vendor_contacts is 'Vendor phone lines for vendorLane routing and dispatch SMS';
comment on column public.vendor_contacts.role is 'dispatch | billing (v1 uses dispatch for outbound)';

alter table public.vendor_contacts enable row level security;

-- ---------------------------------------------------------------------------
-- vendor_conversation_ctx — last ticket for YES/NO shorthand (V2 inbound)
-- ---------------------------------------------------------------------------
create table if not exists public.vendor_conversation_ctx (
  vendor_id text primary key references public.vendors (vendor_id) on delete cascade,
  last_ticket_key text not null default '',
  last_human_ticket_id text not null default '',
  updated_at timestamptz not null default now()
);

comment on table public.vendor_conversation_ctx is 'Per-vendor inbound context; updated on dispatch (V1+) and YES/NO (V2)';

alter table public.vendor_conversation_ctx enable row level security;

-- ---------------------------------------------------------------------------
-- tickets — dispatch idempotency (prefer columns over vendor_notes tokens)
-- ---------------------------------------------------------------------------
alter table public.tickets
  add column if not exists vendor_dispatch_at timestamptz,
  add column if not exists vendor_dispatched_to text not null default '';

comment on column public.tickets.vendor_dispatch_at is 'When dispatch SMS last sent for vendor_dispatched_to';
comment on column public.tickets.vendor_dispatched_to is 'vendors.vendor_id last dispatched';
