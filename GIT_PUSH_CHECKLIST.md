# Git push checklist — Propera + Telegram proxy

## What you need to do first (one-time)

### 1. Create a new repository on GitHub (or GitLab / Bitbucket)

- Go to [github.com/new](https://github.com/new) (or your host).
- **Repository name:** e.g. `propera` or `propera-code`.
- **Visibility:** Private (recommended for code + config).
- **Do NOT** add a README, .gitignore, or license (we already have files).
- Click **Create repository**.

### 2. Copy the remote URL

After creation you’ll see something like:

- **HTTPS:** `https://github.com/YOUR_USERNAME/propera.git`
- **SSH:** `git@github.com:YOUR_USERNAME/propera.git`

Copy the one you’ll use (HTTPS is easier if you haven’t set up SSH keys).

### 3. Make sure you can authenticate

- **HTTPS:** Git will prompt for username + password. Use a **Personal Access Token** as the password (GitHub: Settings → Developer settings → Personal access tokens).
- **SSH:** You need an SSH key added to your GitHub account.

---

## What the assistant can run for you

Once the repo exists and you have the URL:

1. **Initialize git** (if not already): `git init`
2. **Add files:** `git add .`
3. **Commit:** `git commit -m "Add Propera channel neutrality, Telegram adapter, ingress proxy (Phase 1)"`
4. **Add remote:** `git remote add origin YOUR_REPO_URL`
5. **Push:** `git branch -M main; git push -u origin main`

You’ll be prompted for credentials when you run (or the assistant runs) `git push` unless you use SSH with an agent or a credential helper.

---

## Optional: .gitignore (recommended)

So we don’t commit secrets or local config, add a `.gitignore` that includes:

- `.env`
- `.env.local`
- `telegram-proxy/.env`
- `telegram-proxy/.env.local`
- Any other local / secret files you use

The assistant can add a sensible `.gitignore` before the first commit if you want.
