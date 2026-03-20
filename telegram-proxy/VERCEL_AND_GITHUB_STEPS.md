# What to do now: GitHub + Vercel for the Telegram proxy

You have a **Vercel project** and you can see something on **GitHub**. Follow this in order.

---

## 1. Be clear about which repo is which

- **Propera app** = your main code (Apps Script, etc.). That repo might be big.
- **Telegram proxy** = only the small `telegram-proxy` folder we committed (Vercel serverless function). This must be its **own** repo on GitHub.

If you **did not** push the proxy to its own repo yet:
- Go to [github.com/new](https://github.com/new), create a repo named e.g. **propera-telegram-proxy** (empty, no README).
- Then in PowerShell:
  ```powershell
  cd "c:\Users\nicol\OneDrive\Documents\propera code\telegram-proxy"
  git remote add origin https://github.com/YOUR_USERNAME/propera-telegram-proxy.git
  git push -u origin main
  ```
- After that, on GitHub you should see a repo with only: `api/`, `package.json`, `vercel.json`, `README.md`, `.env.example`, `.gitignore`.

---

## 2. In Vercel: use the proxy repo for this project

- Go to [vercel.com](https://vercel.com) and open your **Dashboard**.
- Either you **already have a project** for this, or you will **import** one.

**Option A — Create a new project for the proxy (easiest)**  
1. Click **Add New…** → **Project**.  
2. **Import** the repo that has **only** the telegram proxy (e.g. `propera-telegram-proxy`).  
3. If you don’t see it, click **Adjust GitHub App Permissions** and give Vercel access to that repo.  
4. Leave **Root Directory** as `.` (default).  
5. Click **Deploy**.  
6. Wait for the first deployment to finish.

**Option B — You already have a Vercel project**  
1. Open that project in Vercel.  
2. Go to **Settings** → **Git**.  
3. If the connected repo is the **big Propera app** repo, disconnect it and connect the **proxy repo** instead (the one with only `api/telegram-webhook.js`, etc.).  
4. Trigger a **Redeploy** (Deployments → … on latest → Redeploy).

---

## 3. Set environment variables in Vercel

1. In your **Vercel project** (the one that uses the proxy repo), go to **Settings** → **Environment Variables**.
2. Add:

   - **Name:** `PROPERA_TELEGRAM_FORWARD_URL`  
     **Value:** your Apps Script Web App URL, e.g.  
     `https://script.google.com/macros/s/XXXXXXXXXX/exec`  
     (You get this from Apps Script: Deploy → Manage deployments → Web app URL.)
   - (Optional) **Name:** `PROPERA_PROXY_SECRET`  
     **Value:** a secret string you choose (e.g. a long random string).  
     If you set this, Telegram must send it in header `X-Webhook-Secret` or you can skip it for now.

3. Save. Then **redeploy** the project once (Deployments → … → Redeploy) so the new env vars are used.

---

## 4. Get your proxy URL

1. In Vercel, open your project.
2. Go to **Settings** → **Domains**, or look at the top of the **Deployments** page.
3. Your proxy URL will be something like:
   - `https://propera-telegram-proxy.vercel.app/api/telegram-webhook`  
   or, if you added a custom domain:
   - `https://your-domain.com/api/telegram-webhook`

That URL is what you will give to Telegram as the webhook.

---

## 5. Point Telegram at the proxy (Phase 2)

1. Call Telegram’s `setWebhook` with that URL and `drop_pending_updates: true` (so old updates don’t replay).
2. Send a **new** message in Telegram and check:
   - Vercel: **Logs** or **Functions** for the proxy (one request per message).
   - Propera: **DebugLog** sheet for DOPOST_TOP → TELEGRAM_DETECTED → TELEGRAM_ACCEPTED, etc.

---

## Quick checklist

- [ ] Proxy code is in its **own** GitHub repo (only the 6 proxy files).
- [ ] Vercel **project** is connected to **that** repo (not the big Propera app).
- [ ] Env var **PROPERA_TELEGRAM_FORWARD_URL** is set to your Apps Script Web app URL.
- [ ] One **deploy** or **redeploy** after setting env vars.
- [ ] You have the **proxy URL** (e.g. `https://..../api/telegram-webhook`) to use in Telegram’s setWebhook.

If you tell me where you’re stuck (e.g. “I don’t see the proxy repo in Vercel” or “I don’t have the Apps Script URL”), I can give you the exact clicks for that step.
