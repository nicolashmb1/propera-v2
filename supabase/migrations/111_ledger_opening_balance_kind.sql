-- WESTFIELD Propera-owned register: opening balance before first imported window line.

alter table public.tenant_ledger_entries
  drop constraint if exists tenant_ledger_entries_entry_kind_chk;

alter table public.tenant_ledger_entries
  add constraint tenant_ledger_entries_entry_kind_chk check (
    entry_kind in (
      'charge',
      'payment',
      'credit',
      'fee',
      'waiver',
      'adjustment',
      'opening_balance'
    )
  );

comment on column public.tenant_ledger_entries.entry_kind is
  'opening_balance = one-time register start (Propera fact); WESTFIELD incumbent baseline only.';
