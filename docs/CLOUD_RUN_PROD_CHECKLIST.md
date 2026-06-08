# Cloud Run production — pre-deploy checklist (`propera-v2-prod`)

**Project:** `propera-live` · **Region:** `us-east1` · **Service:** `propera-v2-prod`

Deploy **the same code** as staging into a **separate Cloud Run service** with **separate Secret Manager entries**. This checklist is the gate before `gcloud run deploy propera-v2-prod`.

**Out of scope for this step (do not change yet):**

- Vercel production env (`PROPERA_V2_API_URL`, webhooks)
- Twilio webhook URLs
- Telegram webhook URL
- GitHub Actions cron targets
- Local `npm run dev` / ngrok / `propera-v2/.env`

---

## Phase 0 — Staging gate (must pass first)

| # | Check | How |
|---|--------|-----|
| 0.1 | Staging service healthy | `curl https://<staging-url>/health` → `ok:true`, `db.ok:true` |
| 0.2 | Staging portal auth | `curl -H "x-propera-portal-token: $TOKEN" "<staging>/api/portal/gas-compat?path=properties"` → HTTP 200 |
| 0.3 | Local app → staging | `cd propera-app && npm run dev:staging` — Amenities or Preventive loads via staging brain |
| 0.4 | Staging banner visible | Amber bar when `NEXT_PUBLIC_PROPERA_STAGING_BANNER=1` |
| 0.5 | No accidental cutover | Vercel still on ngrok/local V2; Telegram/Twilio still on ngrok |

Only continue when **0.1–0.3** pass.

---

## Phase 1 — Production secrets (Secret Manager)

Create **new** secrets — **never reuse staging secret names or values by reference**.

### Required (minimum brain)

| Secret Manager name | Maps to env var | Notes |
|---------------------|-----------------|--------|
| **`propera-v2-prod-supabase-url`** | `SUPABASE_URL` | Production Supabase project URL |
| **`propera-v2-prod-supabase-service-role`** | `SUPABASE_SERVICE_ROLE_KEY` | Service role key — server only |
| **`propera-v2-prod-portal-token`** | `PROPERA_PORTAL_TOKEN` | Must match what propera-app will use **after** Vercel cutover (`PROPERA_PORTAL_TOKEN`) |

### Strongly recommended at prod deploy

| Secret Manager name | Maps to env var | Notes |
|---------------------|-----------------|--------|
| **`propera-v2-prod-lifecycle-cron-secret`** | `LIFECYCLE_CRON_SECRET` | For `/internal/cron/lifecycle-timers` when Scheduler is wired |
| **`propera-v2-prod-access-credential-secret`** | `ACCESS_CREDENTIAL_SECRET` | If `PROPERA_ACCESS_ENGINE_ENABLED=1` |
| **`propera-v2-prod-tenant-jwt-secret`** | `TENANT_JWT_SECRET` | If tenant portal API is live |

### Create secrets (one-time)

```bash
gcloud config set project propera-live

# Create empty secrets, then add versions in Console or:
# echo -n "YOUR_VALUE" | gcloud secrets versions add propera-v2-prod-supabase-url --data-file=-

gcloud secrets create propera-v2-prod-supabase-url --replication-policy=automatic
gcloud secrets create propera-v2-prod-supabase-service-role --replication-policy=automatic
gcloud secrets create propera-v2-prod-portal-token --replication-policy=automatic
gcloud secrets create propera-v2-prod-lifecycle-cron-secret --replication-policy=automatic
```

Grant Cloud Run access:

```bash
PROJECT_NUMBER=$(gcloud projects describe propera-live --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

for S in \
  propera-v2-prod-supabase-url \
  propera-v2-prod-supabase-service-role \
  propera-v2-prod-portal-token \
  propera-v2-prod-lifecycle-cron-secret
do
  gcloud secrets add-iam-policy-binding "$S" \
    --member="serviceAccount:${SA}" \
    --role="roles/secretmanager.secretAccessor"
done
```

**Important:** If prod Supabase is the **same project** as local/staging today, values may match — but secrets must still be **separate prod-named entries** so cutover and rotation stay clean.

---

## Phase 2 — Plain env vars (non-secret)

Set on the Cloud Run service (included in deploy command below):

| Env var | Prod value |
|---------|------------|
| `NODE_ENV` | `production` |
| `PORT` | *(Cloud Run injects `8080`)* |
| `PROPERA_TZ` | `America/New_York` *(or your portfolio TZ)* |
| `PROPERA_DEFAULT_ORG_ID` | `grand` *(match live org)* |

Enable feature flags **after** prod health passes — same names as `.env.example`:

| Flag | When |
|------|------|
| `PROPERA_ACCESS_ENGINE_ENABLED=1` | Amenities live |
| `PROPERA_COMMUNICATION_ENGINE_ENABLED=1` | Broadcast SMS |
| `CORE_ENABLED=1` | Default on |
| `TWILIO_*`, `TELEGRAM_*` | Only when channel cutover is planned — **not required for first prod deploy** |

Add via Console → Cloud Run → Edit → Variables, or a second deploy with `--update-env-vars`.

---

## Phase 3 — Deploy production (exact command)

From **`propera-v2/`** — **Option A (recommended, same as staging):**

```bash
gcloud run deploy propera-v2-prod \
  --project=propera-live \
  --region=us-east1 \
  --source=. \
  --platform=managed \
  --port=8080 \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=10 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=300 \
  --set-env-vars="NODE_ENV=production,PROPERA_TZ=America/New_York,PROPERA_DEFAULT_ORG_ID=grand,CORE_ENABLED=1,PROPERA_ACCESS_ENGINE_ENABLED=1,PROPERA_TURNOVER_ENGINE_ENABLED=1,PROPERA_UNIT_LIFECYCLE_ENABLED=1,PROPERA_LEASING_ENGINE_ENABLED=1,PROPERA_FINANCE_ENABLED=1,PROPERA_FINANCE_TICKET_COSTS_ENABLED=1,PROPERA_FINANCE_LEDGER_ENABLED=1,PROPERA_FINANCE_COST_CAPTURE_CHAT=1,PROPERA_FINANCIAL_CAPTURE_ENABLED=1,PROPERA_OPEN_DECK_DAY_CHART_ENABLED=1,PROPERA_COMMUNICATION_ENGINE_ENABLED=1,PROPERA_CONFLICT_MEDIATION_ENABLED=1,TENANT_AGENT_ENABLED=1,JARVIS_ASK_ENABLED=1,JARVIS_PLAN_ENABLED=1,JARVIS_THREAD_ENABLED=1,JARVIS_ASK_LLM_ENABLED=1,JARVIS_VOICE_ENABLED=1,PROPERA_TENANT_I18N_ENABLED=1" \
  --set-secrets="SUPABASE_URL=propera-v2-prod-supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=propera-v2-prod-supabase-service-role:latest,PROPERA_PORTAL_TOKEN=propera-v2-prod-portal-token:latest,LIFECYCLE_CRON_SECRET=propera-v2-prod-lifecycle-cron-secret:latest"
```

**Option B — script (Artifact Registry image):**

```bash
cd propera-v2
bash scripts/deploy-cloud-run-prod.sh
```

---

## Phase 4 — Verify prod (still no cutover)

```bash
PROD_URL=$(gcloud run services describe propera-v2-prod \
  --project=propera-live --region=us-east1 --format='value(status.url)')

curl -sS "${PROD_URL}/health" | jq .
# Expect: ok:true, nodeEnv:production, db.ok:true

# Read-only portal route (use prod portal token secret value):
curl -sS -H "x-propera-portal-token: ${PROPERA_PORTAL_TOKEN}" \
  "${PROD_URL}/api/portal/gas-compat?path=properties" | head -c 200
```

Optional local UI test **without Vercel change**: copy `.env.local.staging.example` → `.env.local.production.example` pattern later; for now use curl only or temporary env override in a throwaway shell session.

**Access / Amenities smoke test (prod brain):**

```bash
curl -sS -H "x-propera-portal-token: ${PROPERA_PORTAL_TOKEN}" \
  "${PROD_URL}/api/portal/access/locations"
# Expect: HTTP 200 + { ok: true, locations: [...] }
# If HTTP 404 + access_engine_disabled → add PROPERA_ACCESS_ENGINE_ENABLED=1 on Cloud Run (see below)
```

---

## Troubleshooting — “Amenities module is off” / `access_engine_disabled`

Access needs **two independent flags** (app + brain):

| Layer | Variable | Where |
|-------|----------|--------|
| **propera-app** | `NEXT_PUBLIC_PROPERA_ACCESS_ENABLED=1` | Vercel **Production** — requires **Redeploy** after change (`NEXT_PUBLIC_*` is build-time) |
| **propera-v2** | `PROPERA_ACCESS_ENGINE_ENABLED=1` | Cloud Run service env — **not** in Vercel |

If the Amenities nav appears but the page says *“Set PROPERA_ACCESS_ENGINE_ENABLED=1 on V2…”*, Vercel is fine — **Cloud Run is missing the V2 flag**.

**Fix (no redeploy of container image):**

```bash
gcloud run services update propera-v2-prod \
  --project=propera-live \
  --region=us-east1 \
  --update-env-vars="PROPERA_ACCESS_ENGINE_ENABLED=1"
```

Or Cloud Console → Cloud Run → `propera-v2-prod` → Edit → Variables → add `PROPERA_ACCESS_ENGINE_ENABLED` = `1` → Deploy new revision.

**Warning:** a full `gcloud run deploy … --set-env-vars=…` **replaces** all plain env vars. Include every flag you need in that string, or use `--update-env-vars` for incremental adds.

**Other modules** follow the same pattern — app `NEXT_PUBLIC_PROPERA_*_ENABLED` + matching V2 flag on Cloud Run. **One-shot prod fix** (PowerShell — single line):

```powershell
gcloud run services update propera-v2-prod --project=propera-live --region=us-east1 --update-env-vars="CORE_ENABLED=1,PROPERA_ACCESS_ENGINE_ENABLED=1,PROPERA_TURNOVER_ENGINE_ENABLED=1,PROPERA_UNIT_LIFECYCLE_ENABLED=1,PROPERA_LEASING_ENGINE_ENABLED=1,PROPERA_FINANCE_ENABLED=1,PROPERA_FINANCE_TICKET_COSTS_ENABLED=1,PROPERA_FINANCE_LEDGER_ENABLED=1,PROPERA_FINANCE_COST_CAPTURE_CHAT=1,PROPERA_FINANCIAL_CAPTURE_ENABLED=1,PROPERA_OPEN_DECK_DAY_CHART_ENABLED=1,PROPERA_COMMUNICATION_ENGINE_ENABLED=1,PROPERA_CONFLICT_MEDIATION_ENABLED=1,TENANT_AGENT_ENABLED=1,JARVIS_ASK_ENABLED=1,JARVIS_PLAN_ENABLED=1,JARVIS_THREAD_ENABLED=1,JARVIS_ASK_LLM_ENABLED=1,JARVIS_VOICE_ENABLED=1,PROPERA_TENANT_I18N_ENABLED=1"
```

See **Feature flag parity table** below for app ↔ V2 mapping. Secrets (`OPENAI_API_KEY`, `TWILIO_*`, `ACCESS_CREDENTIAL_SECRET`, etc.) are separate — flags alone enable API routes, not channel delivery.

### Feature flag parity table (app ↔ V2)

| App (Vercel `NEXT_PUBLIC_*`) | V2 (Cloud Run) | Error if V2 off |
|------------------------------|----------------|-----------------|
| `NEXT_PUBLIC_PROPERA_ACCESS_ENABLED=1` | `PROPERA_ACCESS_ENGINE_ENABLED=1` | `access_engine_disabled` |
| `NEXT_PUBLIC_PROPERA_TURNOVER_ENABLED=1` | `PROPERA_TURNOVER_ENGINE_ENABLED=1` | `turnover_engine_disabled` |
| `NEXT_PUBLIC_PROPERA_UNIT_LIFECYCLE_ENABLED=1` | `PROPERA_UNIT_LIFECYCLE_ENABLED=1` | `unit_lifecycle_disabled` |
| `NEXT_PUBLIC_PROPERA_LEASING_ENABLED=1` | `PROPERA_LEASING_ENGINE_ENABLED=1` | `leasing_disabled` |
| `NEXT_PUBLIC_PROPERA_FINANCE_ENABLED=1` | `PROPERA_FINANCE_ENABLED=1` + `PROPERA_FINANCE_TICKET_COSTS_ENABLED=1` | `finance_disabled` |
| `NEXT_PUBLIC_PROPERA_FINANCE_COST_CAPTURE_CHAT=1` | `PROPERA_FINANCE_COST_CAPTURE_CHAT=1` | Plan/cost capture blocked |
| `NEXT_PUBLIC_PROPERA_OPEN_DECK_DAY_CHART_ENABLED=1` | `PROPERA_OPEN_DECK_DAY_CHART_ENABLED=1` | `open_deck_day_chart_disabled` |
| `NEXT_PUBLIC_PROPERA_COMMUNICATIONS_ENABLED=1` | `PROPERA_COMMUNICATION_ENGINE_ENABLED=1` | comm routes 404 |
| `NEXT_PUBLIC_PROPERA_CONFLICT_MEDIATION_ENABLED=1` | `PROPERA_CONFLICT_MEDIATION_ENABLED=1` | conflict routes 404 |
| `NEXT_PUBLIC_PROPERA_JARVIS_ASK_ENABLED=1` | `JARVIS_ASK_ENABLED=1` | Ask API off |
| `NEXT_PUBLIC_PROPERA_JARVIS_PLAN_ENABLED=1` | `JARVIS_PLAN_ENABLED=1` + `JARVIS_THREAD_ENABLED=1` | Plan proposals off |
| `NEXT_PUBLIC_PROPERA_JARVIS_VOICE_ENABLED=1` | `JARVIS_VOICE_ENABLED=1` | Voice WS off |
| `NEXT_PUBLIC_PROPERA_PREVENTIVE_ENABLED=1` | *(no V2 flag — portal program API)* | — |
| `NEXT_PUBLIC_PROPERA_FINANCIAL_MENU_ENABLED=1` | *(app-only menu)* | — |
| `NEXT_PUBLIC_PROPERA_UTILITY_METER_RUNS_ENABLED=1` | *(app-only)* | — |

**Also set on Cloud Run (brain spine, no app flag):** `CORE_ENABLED=1`, `TENANT_AGENT_ENABLED=1`, `JARVIS_ASK_LLM_ENABLED=1`, `PROPERA_FINANCIAL_CAPTURE_ENABLED=1`, `PROPERA_FINANCE_LEDGER_ENABLED=1`, `PROPERA_TENANT_I18N_ENABLED=1`.

**Needs Secret Manager (not plain env):** `OPENAI_API_KEY`, `TWILIO_*`, `TELEGRAM_*`, `ACCESS_CREDENTIAL_SECRET`, `TENANT_JWT_SECRET`, VAPID keys — add when you cut over those channels.

---

## Phase 5 — Cutover (later, explicit PR)

When prod brain is verified, **one coordinated change**:

1. Vercel `PROPERA_V2_API_URL` → `https://<prod-url>/api/portal/gas-compat`
2. Vercel `PROPERA_V2_WEBHOOK_URL` → `https://<prod-url>/webhooks/portal`
3. Telegram webhook → prod URL `/webhooks/telegram`
4. Twilio webhooks → prod URLs
5. GitHub cron → prod `/internal/cron/*`

Until Phase 5, **prod Cloud Run can run in parallel** with zero traffic from live channels.

---

## Quick reference

| Service | Purpose | Touch live traffic? |
|---------|---------|---------------------|
| `propera-v2-staging` | Pre-prod validation | No |
| `propera-v2-prod` | Production brain | Not until Phase 5 |
| Local ngrok + `npm run dev` | Dev | Unchanged |

See also: **[CLOUD_RUN_DEPLOY.md](./CLOUD_RUN_DEPLOY.md)** · **[../propera-app/docs/STAGING_LOCAL.md](../propera-app/docs/STAGING_LOCAL.md)**
