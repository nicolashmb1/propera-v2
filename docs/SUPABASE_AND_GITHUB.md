# Supabase + GitHub + this repo

## What lives in git

- **`supabase/migrations/*.sql`** — versioned schema. **Commit and push** these with the rest of `propera-v2/` so history matches the database story.

## What Supabase’s GitHub connection does (high level)

When you link **Supabase → GitHub**, Supabase can **watch the repo** and help with **migration workflows** (exact UI depends on your Supabase plan). It does **not** replace:

- Running new SQL against **your** dev project (SQL Editor paste **or** Supabase CLI `db push` after linking the project).

**Typical flow:**

1. We add or change files under **`propera-v2/supabase/migrations/`** in Cursor.
2. You **commit + push** to GitHub (`git add` / `git commit` / `git push` from Cursor terminal or Git UI).
3. For **this branch / dev DB**, you still **apply** migrations: open **SQL Editor**, paste the new `.sql` file, **Run** — until CLI is set up.

## Push from Cursor (this machine)

```bash
cd "path/to/propera code"
git add propera-v2/
git commit -m "Your message"
git push origin <branch>
```

Use your normal branch (`master` / `main`). If `git push` asks for auth, use GitHub Desktop, SSH key, or a personal access token as you already do for other pushes.

## Optional: Supabase CLI later

Install CLI, `supabase link` to the project, then `supabase db push` can apply migrations from this folder without manual paste — optional; manual SQL Editor paste remains valid.
