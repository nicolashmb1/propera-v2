# GAS Sheet1 → Supabase historical import

One-time load of Sheet1 history into Postgres, then normalized upsert into `public.tickets` with **`is_imported_history = true`** (no `work_items` / lifecycle).

## A. CSV via Supabase Table Editor (PascalCase headers)

Sheet exports use headers like **`TicketID`**, **`Phone`**, **`Property`** — **not** the snake_case names on `public.tickets`. Importing CSV directly into `tickets` fails with “incompatible headers”.

1. Apply migration **`027_gas_sheet1_csv_staging.sql`** (creates `public.gas_sheet1_csv_staging` with matching quoted column names).
2. In Supabase → **Table Editor** → **`gas_sheet1_csv_staging`** → **Insert** → **Import data from CSV**.
3. After import, tag the batch:

   ```sql
   update public.gas_sheet1_csv_staging
   set import_batch_id = 'sheet1_2026-05-06'
   where import_batch_id = '';
   ```

4. Run [`validate_csv_staging.sql`](./validate_csv_staging.sql) then [`promote_from_csv_staging.example.sql`](./promote_from_csv_staging.example.sql). In the Supabase SQL editor, **Find & Replace** `__IMPORT_BATCH_ID__` with your batch id (e.g. `sheet1_2026-05-06`) in the script before running — these files do **not** use psql `\set`.

**Header mismatches:** If your file uses different spelling (e.g. `EscalatedToYou` vs `EscaletedToYou`), either fix the CSV header row or add/alter a column on `gas_sheet1_csv_staging` to match exactly.

## B. JSON staging (`gas_sheet1_ticket_import_staging`)

Insert into `gas_sheet1_ticket_import_staging` (`import_batch_id`, `sheet_row`, `row_json`):

- `import_batch_id`: e.g. `sheet1_2026-05-06`
- `sheet_row`: 1-based sheet row index (optional, for auditing)
- `row_json`: JSON object with fields you map in SQL

Use Supabase SQL editor, `psql`, or a small Node script using `@supabase/supabase-js`.

## C. Validate

- CSV path: [`validate_csv_staging.sql`](./validate_csv_staging.sql)
- JSON path: [`validate_staging.sql`](./validate_staging.sql)

In the Supabase SQL editor, replace the placeholder `__IMPORT_BATCH_ID__` in the script (same as for promote). **Do not** use psql-only commands like `\set`.

Fix duplicates / unknown property codes before promote.

## D. Promote

- **CSV:** [`promote_from_csv_staging.example.sql`](./promote_from_csv_staging.example.sql)
- **JSON:** adapt [`promote_batch.example.sql`](./promote_batch.example.sql) — map `row_json` keys into `INSERT INTO public.tickets (...)`, set `source_system = 'gas_sheet1'`, **`is_imported_history = true`**, stable `source_row_hash`, do **not** touch `work_items`.

## E. App reads

With migrations `024` / `025` applied, `propera-app` uses `PROPERA_READ_BACKEND=supabase` and reads `portal_tickets_v1` / aggregates.
