# HiyakuAI — Setup (one-time, ~15 minutes)
Version: v2026:07:05-15:53 · Repo: github.com/Surferyogi/hiyakuai · App: https://surferyogi.github.io/hiyakuai/

## 1. Create the Supabase project (dashboard)
1. https://supabase.com/dashboard → New project
   - Organization: <your-email>'s Org
   - Name: `hiyakuai`  ·  Region: **Southeast Asia (Singapore)**  ·  set a strong DB password
   - Cost: US$10/month (as confirmed)
2. When it finishes provisioning, note from **Project Settings → API**:
   - Project URL  (https://XXXX.supabase.co)
   - anon public key

## 2. Run the schema
- Dashboard → SQL Editor → paste the entire contents of `supabase/migration.sql` → Run.
- Expect "Success. No rows returned."

## 3. Auth setting (recommended for instant single-user login)
- Dashboard → Authentication → Providers → Email → **disable "Confirm email"**
  (you are the only user; this avoids the confirmation-mail step).

## 4. Edge Function + your Anthropic API key
From a terminal on your MacBook (Supabase CLI already installed from Kizuna work):
```bash
cd ~/path/to/hiyakuai          # your local clone of the repo
supabase login                  # if not already
supabase link --project-ref <YOUR_NEW_PROJECT_REF>
supabase secrets set ANTHROPIC_API_KEY=sk-ant-XXXXXXXX   # your own key — never share it in chat
supabase functions deploy hiyaku-generate                # JWT verification stays ON (default)
```

## 5. Configure and deploy the frontend
1. Edit `src/supabaseClient.js` → paste Project URL + anon key from step 1.
2. Then:
```bash
npm install
npm run dev        # optional local test at http://localhost:5173/hiyakuai/
git add -A && git commit -m "HiyakuAI v2026:07:05-15:53 initial" && git pull --no-rebase --no-edit && git push && npm run deploy
```
3. GitHub → repo Settings → Pages → confirm source is the `gh-pages` branch.

## 6. First run
1. Open https://surferyogi.github.io/hiyakuai/ → **Create account** (<your-email> + password) → Sign in.
2. Library tab → **Load starter profile** (pre-loads your CV v2 + LinkedIn headline/About finalized 2026-07-05) → Save profile.
3. Add certificates (PDF/image) and any extra links (publications, etc.).
4. ✨ New tab → paste a job description → Generate → edit → Save.

## iPhone install
Open the URL in Safari → Share → **Add to Home Screen**. Runs as a standalone PWA.

## Notes
- Your Anthropic key lives ONLY as a Supabase secret (server-side). The browser never sees it.
- All tables are RLS-protected to your logged-in user; the certificates bucket is private (signed URLs, 5-min expiry).
- Backup anytime: Settings → Export all data (JSON).
