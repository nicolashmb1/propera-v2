-- Batch media engine + utility meter billing (MVP 1a) — additive; isolated from inbound/tickets core.
-- Photos: bucket utility-meter-runs (public read like pm-attachments; writes via service role).

-- ─── Storage bucket ─────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'utility-meter-runs',
  'utility-meter-runs',
  true,
  15728640,
  array[
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "utility_meter_runs_select_public" on storage.objects;
create policy "utility_meter_runs_select_public"
  on storage.objects
  for select
  to public
  using (bucket_id = 'utility-meter-runs');

-- ─── Engine: batch media run + assets ────────────────────────────────────────
create table if not exists public.batch_media_runs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null default 'METER_BILLING_RUN',
  property_code text not null references public.properties (code) on delete restrict,
  period_month date not null,
  status text not null default 'DRAFT',
  expected_meter_count int not null default 0,
  uploaded_asset_count int not null default 0,
  processed_asset_count int not null default 0,
  auto_accepted_count int not null default 0,
  review_count int not null default 0,
  missing_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint batch_media_runs_run_type_chk check (run_type in ('METER_BILLING_RUN')),
  constraint batch_media_runs_status_chk check (
    status in (
      'DRAFT',
      'READY',
      'UPLOADING',
      'PROCESSING',
      'REVIEW_REQUIRED',
      'BILLING_READY',
      'EXPORTED',
      'CLOSED'
    )
  )
);

create index if not exists batch_media_runs_property_period_idx
  on public.batch_media_runs (property_code, period_month desc);

create table if not exists public.batch_media_assets (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.batch_media_runs (id) on delete cascade,
  storage_bucket text not null default 'utility-meter-runs',
  storage_path text not null,
  mime_type text,
  processing_status text not null default 'UPLOADED',
  last_error text,
  extraction_json jsonb,
  created_at timestamptz not null default now(),
  constraint batch_media_assets_processing_chk check (
    processing_status in ('UPLOADED', 'QUEUED', 'PROCESSING', 'EXTRACTED', 'VALIDATED', 'FAILED')
  ),
  constraint batch_media_assets_path_uniq unique (storage_bucket, storage_path)
);

create index if not exists batch_media_assets_run_idx on public.batch_media_assets (run_id);

-- ─── Meter registry + per-run readings ───────────────────────────────────────
create table if not exists public.utility_meters (
  id uuid primary key default gen_random_uuid(),
  meter_key text not null,
  property_code text not null references public.properties (code) on delete restrict,
  unit_label text not null default '',
  utility_type text not null default 'water',
  location_note text default '',
  previous_reading bigint,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint utility_meters_key_prop_uniq unique (property_code, meter_key)
);

create index if not exists utility_meters_property_idx on public.utility_meters (property_code);

create table if not exists public.utility_meter_readings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.batch_media_runs (id) on delete cascade,
  meter_id uuid not null references public.utility_meters (id) on delete restrict,
  asset_id uuid references public.batch_media_assets (id) on delete set null,
  previous_reading bigint,
  current_reading bigint,
  usage bigint,
  estimated_charge numeric,
  status text not null default 'MISSING',
  review_reasons jsonb not null default '[]'::jsonb,
  possible_dollar_variance numeric,
  extraction_json jsonb,
  corrected_from bigint,
  corrected_by text,
  corrected_at timestamptz,
  unique (run_id, meter_id),
  constraint utility_meter_readings_status_chk check (
    status in ('AUTO_ACCEPTED', 'CHECK_PHOTO', 'CORRECTED', 'MISSING', 'DUPLICATE', 'REJECTED')
  )
);

create index if not exists utility_meter_readings_run_idx on public.utility_meter_readings (run_id);

comment on table public.batch_media_runs is 'Shared batch media run root (MVP: meter billing only)';
comment on table public.batch_media_assets is 'Photos/files attached to a batch_media_run';
comment on table public.utility_meters is 'Meter registry; previous_reading is last office-confirmed reading for usage baseline';
comment on table public.utility_meter_readings is 'One row per meter per run; deterministic validation sets status';
