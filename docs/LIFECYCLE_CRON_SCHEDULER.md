# Lifecycle timers — external scheduler

**Propera V2 remains the lifecycle brain.** Rows in `public.lifecycle_timers` are storage only: Supabase and RLS do **not** fire timers or run lifecycle policy.

To process due timers, something **outside** Postgres must call:

`POST /internal/cron/lifecycle-timers`

with header:

`x-propera-cron-secret: <same value as V2 env LIFECYCLE_CRON_SECRET>`

Requirements:

- **`LIFECYCLE_CRON_SECRET`** must be **non-empty** in the V2 deployment that owns lifecycle; otherwise every cron request gets `401`.
- The scheduler must target the **same** V2 deployment that points at the **same** Supabase project (same DB) where timers are written.
- Recommended cadence: **every 1–5 minutes** (5 minutes is usually enough slack for policy timers).
- The scheduler **must not** embed lifecycle rules; it only wakes the existing endpoint.

### GitHub Actions (optional)

This repo includes `.github/workflows/lifecycle-cron.yml`, which runs on a schedule and `workflow_dispatch`. Configure repository secrets:

| Secret | Purpose |
|--------|--------|
| **`PROPERA_LIFECYCLE_CRON_URL`** | Full URL to the cron path on your deployed V2 host (see examples below). |
| **`LIFECYCLE_CRON_SECRET`** | Must **exactly match** V2’s `LIFECYCLE_CRON_SECRET`. |

The workflow never prints the secret; it only sends it as a header.

Example **dev** URL (ngrok — **temporary**, rotate when the tunnel changes):

`https://YOUR-SUBDOMAIN.ngrok-free.dev/internal/cron/lifecycle-timers`

Example **production** URL:

`https://YOUR-PRODUCTION-V2-HOST/internal/cron/lifecycle-timers`

**ngrok is dev-only.** Production should use a stable hostname (Cloud Run, Fly.io, Railway, etc.) plus Cloud Scheduler, GitHub Actions, or another external cron.

### Manual test (PowerShell)

```powershell
$headers = @{
  "x-propera-cron-secret" = "YOUR_SECRET"
  "ngrok-skip-browser-warning" = "true"
}

Invoke-RestMethod `
  -Method Post `
  -Uri "https://YOUR-V2-HOST/internal/cron/lifecycle-timers" `
  -Headers $headers
```

Typical JSON shape (counts vary):

```json
{
  "ok": true,
  "due": 4,
  "claimed": 4,
  "processed": 4,
  "skipped": 0,
  "trace_id": "…"
}
```

`trace_id` is also returned as response header **`X-Trace-Id`** when request context middleware runs.

### Alternatives

If GitHub Actions is not suitable (private infra only, no GitHub secrets, etc.), use **Google Cloud Scheduler**, **cron on a small VM**, or any HTTPS-capable job runner with the same POST + headers. Do **not** move timer firing into Supabase Edge Functions as business logic unless you keep that function as a thin HTTP caller into V2 (still one brain); the default pattern is to call V2 directly.

### Terminal work items and stale `pending` timers

When a work item or ticket reaches a terminal state through V2 DAL/lifecycle paths, V2 cancels **pending** timers for the affected work item(s) and records `cancel_reason` / `cancelled_at` on the row `payload`. For historical bad rows, see `docs/ops/lifecycle-timers-stale-pending.sql`.
