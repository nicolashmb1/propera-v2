# Where do env variables go now?

You used to edit **`propera-v2/.env`** for everything. That still works for **local dev**. Production brain on **Cloud Run** has no `.env` file — vars live in **Google Cloud**.

---

## Three places (don’t mix them up)

| What you're running | Where to add V2 variables |
|---------------------|---------------------------|
| **Local brain** (`npm start` in propera-v2) | **`propera-v2/.env`** — same as before |
| **Cloud Run prod/staging** | **Google Cloud Console** or **`gcloud`** — not a file in the repo |
| **Staff portal** (propera-app) | **`propera-app/.env.local`** (local) or **Vercel dashboard** (production) |

Cloud Run **never reads** `propera-v2/.env` from your laptop. Copy values from `.env` into Cloud Run when you need parity.

Reference template (names + comments): **`propera-v2/.env.example`**

**Full prod plain-env list (flags + config, no secrets):** edit **`propera-v2/config/cloud-run-prod.plain.env`**, then:

```powershell
cd propera-v2
npm run cloud-run:sync-prod-env
```

Secrets checklist: **`config/cloud-run-prod.secrets.env.example`**

**How to update secrets:** **[docs/CLOUD_RUN_SECRETS.md](./CLOUD_RUN_SECRETS.md)** — or `npm run cloud-run:sync-prod-secrets` after filling `config/cloud-run-prod.secrets.local.env`

---

## Local propera-v2 — still `.env`

```powershell
cd propera-v2
# Edit .env — same workflow as always
npm start
```

Restart V2 after changes. Used with ngrok for Twilio/Telegram during local dev.

### `gcloud` in Cursor terminal (Windows)

If `gcloud` is “not recognized” in Cursor but works elsewhere:

1. **Restart Cursor** (picks up Windows User PATH), or open a **new terminal** tab.
2. This repo’s **`.vscode/settings.json`** prepends the Cloud SDK to `Path` in integrated terminals.
3. PowerShell profile also adds the SDK if missing (`$PROFILE`).

SDK location: `%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin`

Quick test:

```powershell
gcloud --version
gcloud config set project propera-live
```

---

## Cloud Run propera-v2 — two buckets

### A. Plain env vars (flags, non-secret config)

Examples: `PROPERA_ACCESS_ENGINE_ENABLED=1`, `PROPERA_TZ`, `CORE_ENABLED`, `JARVIS_ASK_ENABLED`

**Console (easiest):**

1. [Cloud Run → propera-v2-prod](https://console.cloud.google.com/run/detail/us-east1/propera-v2-prod/edit?project=propera-live)
2. **Edit & deploy new revision**
3. **Variables & secrets** → **Environment variables** → Add
4. Deploy

**CLI (Windows PowerShell — add gcloud to PATH first):**

```powershell
$env:Path += ";$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin"

# Add or update one flag
gcloud run services update propera-v2-prod `
  --project=propera-live `
  --region=us-east1 `
  --update-env-vars="PROPERA_ACCESS_ENGINE_ENABLED=1"
```

`--update-env-vars` **merges** — it does not wipe other vars.

**Warning:** `gcloud run deploy … --set-env-vars=…` **replaces all** plain env vars. Use the full flag list from `scripts/deploy-cloud-run-prod.sh` or `--update-env-vars` for one-offs.

### B. Secrets (passwords, API keys, tokens)

Examples: `SUPABASE_SERVICE_ROLE_KEY`, `PROPERA_PORTAL_TOKEN`, `OPENAI_API_KEY`, `TWILIO_AUTH_TOKEN`

**Never** put these as plain Cloud Run env vars in production. Use **Secret Manager**:

| Secret Manager name (prod) | Becomes env var on Cloud Run |
|----------------------------|------------------------------|
| `propera-v2-prod-supabase-url` | `SUPABASE_URL` |
| `propera-v2-prod-supabase-service-role` | `SUPABASE_SERVICE_ROLE_KEY` |
| `propera-v2-prod-portal-token` | `PROPERA_PORTAL_TOKEN` |
| `propera-v2-prod-lifecycle-cron-secret` | `LIFECYCLE_CRON_SECRET` |

**Add a new secret version (Console):**

1. [Secret Manager](https://console.cloud.google.com/security/secret-manager?project=propera-live)
2. Open secret (or create) → **New version** → paste value

**Wire secret to Cloud Run:**

1. Cloud Run → Edit service → **Variables & secrets** → **Reference a secret**
2. Env var name = e.g. `OPENAI_API_KEY`, secret = your secret name, version = `latest`

**CLI — create secret + bind (example OPENAI):**

```powershell
# Create secret (once)
echo -n "sk-..." | gcloud secrets create propera-v2-prod-openai-api-key `
  --project=propera-live --data-file=-

# Grant Cloud Run access (once per secret)
$PROJECT_NUMBER = gcloud projects describe propera-live --format="value(projectNumber)"
$SA = "$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding propera-v2-prod-openai-api-key `
  --project=propera-live `
  --member="serviceAccount:$SA" `
  --role="roles/secretmanager.secretAccessor"

# Mount on the service
gcloud run services update propera-v2-prod `
  --project=propera-live `
  --region=us-east1 `
  --update-secrets="OPENAI_API_KEY=propera-v2-prod-openai-api-key:latest"
```

---

## What goes where — quick map

| Variable type | Local `.env` | Cloud Run |
|---------------|--------------|-----------|
| Feature flags (`PROPERA_*_ENABLED=1`) | ✓ | Plain env var |
| `PROPERA_TZ`, `PROPERA_DEFAULT_ORG_ID` | ✓ | Plain env var |
| `SUPABASE_URL`, service role | ✓ | Secret Manager |
| `PROPERA_PORTAL_TOKEN` | ✓ | Secret Manager |
| `OPENAI_API_KEY` | ✓ | Secret Manager (when Jarvis/intake needed on Cloud Run) |
| `TWILIO_*`, `TELEGRAM_*` | ✓ (ngrok dev) | Secret Manager (when channels cut over) |
| `ACCESS_CREDENTIAL_SECRET` | ✓ | Secret Manager |

---

## Workflow when you add a new variable locally

1. Add to **`propera-v2/.env`** and test with `npm start`.
2. Add the **same name** to Cloud Run:
   - Flag / config → **Environment variable**
   - Secret → **Secret Manager** + reference on service
3. If the staff app also needs it → **`propera-app/.env.local`** or **Vercel** (often a different name, e.g. `NEXT_PUBLIC_*`).

Redeploy Cloud Run revision after changes (Console deploy or `gcloud run services update` — no full image rebuild needed for env/secret changes).

---

## Staging vs prod

| Service | Use for |
|---------|---------|
| `propera-v2-staging` | `npm run dev:staging` — separate secrets (`propera-v2-staging-*`) |
| `propera-v2-prod` | Vercel production — secrets (`propera-v2-prod-*`) |

Same variable **names** on both services; different **secret values/names** in Secret Manager.

---

## See also

- **`docs/CLOUD_RUN_PROD_CHECKLIST.md`** — prod secrets list + deploy
- **`docs/CLOUD_RUN_DEPLOY.md`** — staging + Docker
- **`../propera-app/docs/RUNTIME_FLOW.md`** — app + brain + Vercel map
