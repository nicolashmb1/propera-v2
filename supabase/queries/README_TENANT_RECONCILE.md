# Tenant roster ↔ financial reconcile (manual workflow)

## The loop

```text
1. RUN comparison SQL
2. PASTE results in Cursor chat
3. REVIEW row by row — agree on fix per status
4. RUN fix SQL (one block at a time)
5. RE-RUN comparison — repeat until clean
```

## Step 1 — Comparison (full detail)

**File:** `tenant_roster_financial_reconcile.sql`

Supabase → SQL Editor → paste → Run → Download CSV or copy table.

Uncomment for one property:

```sql
and property_code = 'WESTFIELD'
and reconcile_status not in ('match', 'both_vacant')
```

## Step 1b — Summary (paste in chat first)

**File:** `tenant_roster_reconcile_summary.sql`

Run block **A** for counts. Uncomment block **B** for issue list.

Paste something like:

```text
WESTFIELD summary:
missing_roster: 12
name_drift: 8
match: 45
...
```

## Step 2 — Chat review

Paste summary + any problem rows. We decide per unit:

| Status | Action |
|--------|--------|
| `missing_roster` | FIX D insert (need phone) |
| `name_drift` | FIX A or bulk FIX E |
| `roster_without_lh_tenant` | FIX B deactivate |
| `multiple_active_roster` | FIX B on wrong row |
| `name_ok_phone_missing` | FIX C |

## Step 3 — Fixes

**File:** `tenant_roster_financial_fix.sql`

- Uncomment **one** fix block
- Replace UUIDs / names / phones
- Run `begin;` … `returning` … review → `commit;` or `rollback;`

**Never** bulk FIX E without reviewing the `returning` preview on staging.

## Step 4 — Verify

Re-run comparison SQL. Goal: only `match` and `both_vacant` left.

## Prerequisite

`tenant_account_snapshots` must exist (run Leasehold import first).
