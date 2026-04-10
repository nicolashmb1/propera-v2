-- category_final was Sheet/AppSheet display; v2 uses tickets.category only.
-- Column kept for DBs that already ran 006 (default ''). Safe to re-run.

comment on column public.tickets.category_final is
  'Legacy AppSheet column; unused in Propera v2. Authoritative label is category.';
