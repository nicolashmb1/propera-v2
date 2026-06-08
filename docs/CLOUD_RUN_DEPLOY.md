# Propera V2 — Google Cloud Run (staging + production)

**Project:** `propera-live` · **Region:** `us-east1`

| Service | Purpose |
|---------|---------|
| **`propera-v2-staging`** | Pre-prod validation — local `npm run dev:staging` |
| **`propera-v2-prod`** | Production brain — deploy only after **[CLOUD_RUN_PROD_CHECKLIST.md](./CLOUD_RUN_PROD_CHECKLIST.md)** |

Same **code** / **Dockerfile** for both; **separate Secret Manager names** and Cloud Run services.

This doc prepares Cloud Run deployment **without** changing local dev, Vercel production, or live Telegram/Twilio webhook URLs until an explicit cutover.

---

## Local dev unchanged

| Concern | Local behavior |
|--------|----------------|
| Port | **`PORT=8080`** in `.env` (default) → `http://localhost:8080` |
| Env file | **`propera-v2/.env`** loaded from package root (`src/config/env.js`) |
| ngrok | Keep pointing at **`localhost:8080`** for webhook testing |
| Vercel / propera-app | **No change** — still uses local V2 or existing prod URL until you cut over |
| Webhooks | **No change** — Telegram/Twilio stay on ngrok until a deliberate cutover |

Cloud Run injects env vars via the platform; **no `.env` file** in the container. Dotenv still runs locally only.

---

## Runtime checklist (verified in repo)

| # | Requirement | Status |
|---|-------------|--------|
| 1 | Listen on **`process.env.PORT \|\| 8080`** | `src/config/env.js` → `port: parseInt(env("PORT", "8080"), 10) \|\| 8080` |
| 2 | Bind **`0.0.0.0`** (Cloud Run) | `listenHost: env("HOST", "0.0.0.0")` → `app.listen(port, listenHost, …)` |
| 3 | Production start | `npm start` or `npm run start:production` → `node src/index.js` |
| 4 | Docker / Cloud Run | `Dockerfile` → `CMD ["node", "src/index.js"]`, `ENV PORT=8080` |
| 5 | Health probe | **`GET /health`** → `{ ok: true, service: "propera-v2", db: { … } }` |

Local check:

```bash
cd propera-v2
npm start
curl http://localhost:8080/health
```

---

## Required env vars — Cloud Run staging (minimum brain)

Set these on the **`propera-v2-staging`** service (Secret Manager recommended; see below).

### Required (service will boot but brain is dead without DB)

| Variable | Purpose |
|----------|---------|
| **`NODE_ENV`** | `production` |
| **`PORT`** | Set automatically by Cloud Run (`8080`) — do not hardcode in Dockerfile only |
| **`SUPABASE_URL`** | Supabase project URL |
| **`SUPABASE_SERVICE_ROLE_KEY`** | Server-only DB key (never browser) |
| **`PROPERA_PORTAL_TOKEN`** | Shared secret for `GET/POST /api/portal/*` and `POST /webhooks/portal` (same as propera-app `PROPERA_PORTAL_TOKEN`) |

### Strongly recommended (staging parity)

| Variable | Purpose |
|----------|---------|
| **`PROPERA_TZ`** | Property clock zone (e.g. `America/New_York`) — also sets Node `TZ` |
| **`LIFECYCLE_CRON_SECRET`** | `POST /internal/cron/lifecycle-timers` (Cloud Scheduler later) |
| **`ACCESS_CREDENTIAL_SECRET`** | Encrypt amenity PINs at rest (if Access Engine on) |
| **`PROPERA_DEFAULT_ORG_ID`** | Multi-org spine default (e.g. `grand`) |

### Enable only when testing that slice on staging

| Variable | Slice |
|----------|--------|
| `PROPERA_ACCESS_ENGINE_ENABLED=1` | Amenities / access API |
| `PROPERA_COMMUNICATION_ENGINE_ENABLED=1` + Twilio vars | Broadcast SMS |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Telegram inbound (webhook URL still ngrok until cutover) |
| `TWILIO_*`, `TWILIO_OUTBOUND_ENABLED=1` | SMS/WA inbound/outbound |
| `OPENAI_API_KEY`, `INTAKE_LLM_ENABLED=1` | LLM intake |
| `TENANT_JWT_SECRET` | Tenant portal API |
| `JARVIS_*`, `PROPERA_VOICE_*` | Jarvis / voice (needs `PROPERA_PUBLIC_BASE_URL` = staging Run URL when testing) |

Full catalog: **`.env.example`**. Cloud Run uses the **same names** — no renames.

---

## One-time GCP setup

```bash
gcloud auth login
gcloud config set project propera-live
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com
```

### Artifact Registry (optional — for image-based deploys)

```bash
gcloud artifacts repositories create propera \
  --repository-format=docker \
  --location=us-east1 \
  --description="Propera containers"
```

### Secret Manager (recommended for staging)

Create secrets (values from your staging Supabase / portal token — **never commit**):

```bash
# Example names — adjust values in console or via echo -n | gcloud secrets create
gcloud secrets create propera-v2-staging-supabase-url --replication-policy=automatic
gcloud secrets create propera-v2-staging-supabase-service-role --replication-policy=automatic
gcloud secrets create propera-v2-staging-portal-token --replication-policy=automatic

# Grant Cloud Run service account access (default compute SA or custom)
PROJECT_NUMBER=$(gcloud projects describe propera-live --format='value(projectNumber)')
for S in propera-v2-staging-supabase-url propera-v2-staging-supabase-service-role propera-v2-staging-portal-token; do
  gcloud secrets add-iam-policy-binding "$S" \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

---

## Deploy — `propera-v2-staging` (first deploy)

### Option A — source deploy (simplest; no Dockerfile push step)

From **`propera-v2/`**:

```bash
gcloud run deploy propera-v2-staging \
  --project=propera-live \
  --region=us-east1 \
  --source=. \
  --platform=managed \
  --port=8080 \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=3 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=300 \
  --set-env-vars="NODE_ENV=production,PROPERA_TZ=America/New_York" \
  --set-secrets="SUPABASE_URL=propera-v2-staging-supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=propera-v2-staging-supabase-service-role:latest,PROPERA_PORTAL_TOKEN=propera-v2-staging-portal-token:latest"
```

First deploy without Secret Manager (staging smoke test only — **do not paste secrets into shell history on shared machines**):

```bash
gcloud run deploy propera-v2-staging \
  --project=propera-live \
  --region=us-east1 \
  --source=. \
  --port=8080 \
  --allow-unauthenticated \
  --set-env-vars="NODE_ENV=production,SUPABASE_URL=...,SUPABASE_SERVICE_ROLE_KEY=...,PROPERA_PORTAL_TOKEN=..."
```

### Option B — script (image build + deploy)

```bash
cd propera-v2
bash scripts/deploy-cloud-run-staging.sh
```

Requires Artifact Registry repo `propera` in `us-east1` (see above).

---

## After deploy — verify staging only

```bash
STAGING_URL=$(gcloud run services describe propera-v2-staging \
  --project=propera-live --region=us-east1 --format='value(status.url)')

curl "${STAGING_URL}/health"
# Expect: {"ok":true,"service":"propera-v2",...,"db":{"configured":true,"ok":true}}
```

**Do not** point Telegram/Twilio webhooks at this URL until cutover.  
**Do not** change Vercel `PROPERA_V2_API_URL` until staging is validated.

**Preferred:** propera-app **`npm run dev:staging`** (see **`../propera-app/docs/STAGING_LOCAL.md`**) — overrides V2 URLs via `.env.local.staging` without editing your normal `.env.local` or Vercel.

Keep ngrok on **`localhost:8080`** for channel webhook dev.

---

## Production — `propera-v2-prod`

**Complete the checklist first:** **[CLOUD_RUN_PROD_CHECKLIST.md](./CLOUD_RUN_PROD_CHECKLIST.md)**

### Required prod secrets (Secret Manager)

| Secret name | Env var |
|-------------|---------|
| `propera-v2-prod-supabase-url` | `SUPABASE_URL` |
| `propera-v2-prod-supabase-service-role` | `SUPABASE_SERVICE_ROLE_KEY` |
| `propera-v2-prod-portal-token` | `PROPERA_PORTAL_TOKEN` |
| `propera-v2-prod-lifecycle-cron-secret` | `LIFECYCLE_CRON_SECRET` *(strongly recommended at deploy)* |

Optional later: `propera-v2-prod-access-credential-secret`, `propera-v2-prod-tenant-jwt-secret`, Twilio/Telegram/OpenAI secrets when channels cut over.

### Exact prod deploy command

From **`propera-v2/`**:

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
  --set-env-vars="NODE_ENV=production,PROPERA_TZ=America/New_York,PROPERA_DEFAULT_ORG_ID=grand" \
  --set-secrets="SUPABASE_URL=propera-v2-prod-supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=propera-v2-prod-supabase-service-role:latest,PROPERA_PORTAL_TOKEN=propera-v2-prod-portal-token:latest,LIFECYCLE_CRON_SECRET=propera-v2-prod-lifecycle-cron-secret:latest"
```

Script (Artifact Registry): **`bash scripts/deploy-cloud-run-prod.sh`**

### Verify prod (no cutover yet)

```bash
PROD_URL=$(gcloud run services describe propera-v2-prod \
  --project=propera-live --region=us-east1 --format='value(status.url)')

curl "${PROD_URL}/health"
curl -H "x-propera-portal-token: $PROPERA_PORTAL_TOKEN" \
  "${PROD_URL}/api/portal/gas-compat?path=properties"
```

**Do not** update Vercel, Twilio, Telegram, or GitHub cron until **[CLOUD_RUN_PROD_CHECKLIST.md](./CLOUD_RUN_PROD_CHECKLIST.md)** Phase 5.

---

## Files in repo

| File | Role |
|------|------|
| `Dockerfile` | Cloud Run / `gcloud builds submit` |
| `.dockerignore` | Smaller image; excludes tests/docs |
| `scripts/deploy-cloud-run-staging.sh` | Repeatable staging deploy |
| `scripts/deploy-cloud-run-prod.sh` | Repeatable production deploy |
| `docs/CLOUD_RUN_PROD_CHECKLIST.md` | Pre-prod gate + secret list |
| `src/config/env.js` | `PORT`, `HOST`, dotenv from package root |
| `src/index.js` | Express + `/health` |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Container failed to start | Check Cloud Run logs; usually missing `SUPABASE_*` |
| `/health` `db.ok: false` | Wrong Supabase project or migrations not applied |
| Deploy fails on secret IAM / missing secret | `cloud-run-prod-secrets-arg.ps1` **skips** bindings whose Secret Manager entries do not exist yet. Optional secrets (`access-credential`, `telegram-webhook`, …) can be added later via `npm run cloud-run:sync-prod-secrets`. |
| Local still works | `.env` unchanged; Cloud Run vars are separate |
| Port clash on Windows | `netstat -ano \| findstr :8080` — keep V2 on 8080, app on 3000 |

See also: **[OUTSIDE_CURSOR.md](./OUTSIDE_CURSOR.md)** (Supabase migrations), **[README.md](../README.md)** (local ports), **[CLOUD_RUN_PROD_CHECKLIST.md](./CLOUD_RUN_PROD_CHECKLIST.md)** (production deploy gate).
