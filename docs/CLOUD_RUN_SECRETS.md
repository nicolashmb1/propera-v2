# Updating Cloud Run secrets (propera-v2-prod)

Secrets are **not** in `cloud-run-prod.plain.env`. They live in **Google Secret Manager** and are **mounted** on the Cloud Run service.

---

## Option A — Like `.env` (recommended)

**One command** — copies `propera-v2/.env` to Cloud Run (flags + secrets):

```powershell
cd propera-v2
npm run cloud-run:bootstrap-from-local-env
```

Or step by step:

1. Copy the template:

   ```powershell
   cd propera-v2
   Copy-Item config\cloud-run-prod.secrets.local.env.example config\cloud-run-prod.secrets.local.env
   ```

   **File location:** `propera-v2\config\cloud-run-prod.secrets.local.env` (not the repo root)

2. Paste values from **`propera-v2/.env`** into `cloud-run-prod.secrets.local.env` (only the keys you need).

3. Push to GCP:

   ```powershell
   npm run cloud-run:sync-prod-secrets
   ```

   This script:
   - Creates Secret Manager entries if missing (`config/cloud-run-prod.secrets.bindings`)
   - Adds a **new version** for each non-empty value
   - Grants Cloud Run access
   - Mounts secrets on `propera-v2-prod` (new revision)

**`cloud-run-prod.secrets.local.env` is gitignored** — never commit it.

---

## Option B — Google Cloud Console (no CLI)

### Update an existing secret value

1. [Secret Manager](https://console.cloud.google.com/security/secret-manager?project=propera-live)
2. Click secret (e.g. `propera-v2-prod-portal-token`)
3. **New version** → paste value → Save
4. Cloud Run uses `:latest` → open [propera-v2-prod](https://console.cloud.google.com/run/detail/us-east1/propera-v2-prod/edit?project=propera-live) → **Edit & deploy new revision** (can redeploy without changes to pick up new `latest`)

### Add a new secret to Cloud Run

1. Secret Manager → **Create secret** (e.g. `propera-v2-prod-openai-api-key`) → add value
2. Cloud Run → **Edit** → **Variables & secrets** → **Reference a secret**
   - Name: `OPENAI_API_KEY` (env var the Node app reads)
   - Secret: `propera-v2-prod-openai-api-key`
   - Version: `latest`
3. Deploy revision

---

## Option C — gcloud (manual)

**New secret + version:**

```powershell
gcloud config set project propera-live

# Create (once)
gcloud secrets create propera-v2-prod-openai-api-key --replication-policy=automatic

# Add value (each update = new version)
"YOUR_OPENAI_KEY" | gcloud secrets versions add propera-v2-prod-openai-api-key --data-file=-
```

**Grant Cloud Run access (once per secret):**

```powershell
$N = gcloud projects describe propera-live --format="value(projectNumber)"
$SA = "$N-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding propera-v2-prod-openai-api-key `
  --member="serviceAccount:$SA" `
  --role="roles/secretmanager.secretAccessor"
```

**Mount on the service:**

```powershell
gcloud run services update propera-v2-prod `
  --region=us-east1 `
  --update-secrets="OPENAI_API_KEY=propera-v2-prod-openai-api-key:latest"
```

Use `--update-secrets` to **add** bindings. `--set-secrets` **replaces all** secret bindings — easy to accidentally drop Supabase keys.

---

## What's already wired

| Env var on Cloud Run | Secret Manager name |
|----------------------|---------------------|
| `SUPABASE_URL` | `propera-v2-prod-supabase-url` |
| `SUPABASE_SERVICE_ROLE_KEY` | `propera-v2-prod-supabase-service-role` |
| `PROPERA_PORTAL_TOKEN` | `propera-v2-prod-portal-token` |
| `LIFECYCLE_CRON_SECRET` | `propera-v2-prod-lifecycle-cron-secret` |

Full binding list: **`config/cloud-run-prod.secrets.bindings`**

---

## Priority — what to add first

| Secret | Unblocks |
|--------|----------|
| `OPENAI_API_KEY` | Jarvis, intake LLM, OCR, voice, expense scan |
| `TENANT_JWT_SECRET` | Tenant portal auth on Cloud Run |
| `SEAM_API_KEY` | Amenity locks |
| `TWILIO_*` / `TELEGRAM_*` | When webhooks move off ngrok |

Plain flags without secrets = routes enabled but calls fail at runtime.

---

## Vercel note

`PROPERA_PORTAL_TOKEN` must match on **Vercel** and **Cloud Run** (same value as `propera-v2-prod-portal-token`). Updating the secret alone does not update Vercel — change both or keep them in sync.

See also: **[ENV_WHERE.md](./ENV_WHERE.md)**
