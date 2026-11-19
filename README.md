# H-Pharmacy Customer Inbox

A standalone support inbox for H-Pharmacy. Customers open the site and get a private guest
inbox right away, with no signup, login or OTP. One admin signs in to a separate dashboard,
sees every conversation by recent activity with unread counts, and replies live.

Requirements and phases: [PROJECT_ARCHITECTURE.md](PROJECT_ARCHITECTURE.md).
**Current status: Phase 1 (local text chat).** Images, voice notes, backups and deployment
are later phases.

## Stack

- Next.js 16 (App Router, TypeScript, Tailwind CSS 4), Node.js 22
- Supabase Auth (anonymous guests and an email/password admin), Postgres with Row Level
  Security, and Realtime (Postgres Changes)

## How access works

| Concern | Where it is enforced |
| --- | --- |
| Guest identity | Supabase anonymous session stored in the browser's `localStorage` (`hp-guest-auth`) |
| One inbox per guest | `UNIQUE (customer_id)` on `conversations` plus `get_or_create_my_conversation()` |
| Reading threads/messages | RLS `SELECT` policies: the guest's own conversation, or the admin |
| Writing messages | Only `send_message()`, which derives sender and role from `auth.uid()`. Browsers have **no** INSERT/UPDATE/DELETE privilege |
| Admin role | `private.admins` table in a schema the API does not expose. Anonymous sessions can never be the admin |
| Admin pages | Server-side check in `src/app/admin/(dashboard)/layout.tsx` plus the same RLS in the database |
| Realtime | Postgres Changes, filtered per subscriber by the same RLS policies |
| Customer reference (`HP-XXXXXX`) | Display label for the admin only. No policy or function uses it for access |
| Guest vs admin in one browser | Separate storage. Guest uses `localStorage` (`hp-guest-auth`); admin uses cookies (`hp-admin-auth`). An admin sign-in or sign-out never touches the guest inbox |

If a guest's session is lost (cleared storage, another browser or device), the next visit
creates a new inbox. The old conversation remains visible in the admin dashboard.

## Project layout

```
supabase/migrations/20261119000100_phase1_text_chat.sql   schema, RLS, functions, Realtime
supabase/snippets/add_admin.sql                           grant admin to one account (run by hand)
supabase/snippets/cleanup_isolation_test_data.sql         remove verify-script test threads
scripts/verify-isolation.mjs                              two-guest isolation + Realtime checks
src/app/page.tsx, guest-inbox.tsx                         customer inbox (/)
src/app/admin/login                                       admin sign-in (/admin/login)
src/app/admin/(dashboard)                                 protected dashboard (/admin, /admin/c/[id])
src/lib/chat/use-conversation-messages.ts                 history, live updates, catch-up, retries
src/lib/supabase/*                                        separated guest/admin clients
src/proxy.ts                                              refreshes admin session cookies on /admin
```

---

## Setup (exact steps)

### 1. Local prerequisites

- Node.js 22 and npm (check with `node --version` and `npm --version`)
- Git

```powershell
npm install
```

### 2. Create the Supabase project

1. Go to <https://supabase.com/dashboard> → **New project**. Use a dedicated project on the
   **Free** plan. A nearby region such as Mumbai (`ap-south-1`) or Singapore is a good choice.
   Store the database password in your own password manager. The app does not need it.
2. **Enable anonymous sign-ins:** **Authentication → Sign In / Providers** → turn on
   **Allow anonymous sign-ins** → Save.
3. Leave the **Email** provider enabled. The admin signs in with email and password.

### 3. Apply the database migration

Choose **one** of these options.

**Option A, SQL Editor (simplest):** **SQL Editor → New query** → paste the whole contents of
`supabase/migrations/20261119000100_phase1_text_chat.sql` → **Run**. It should finish with
"Success. No rows returned".

**Option B, Supabase CLI:**

```powershell
npx supabase login
```

```powershell
npx supabase link --project-ref YOUR_PROJECT_REF
```

```powershell
npx supabase db push
```

Then confirm:

- **Database → Publications → supabase_realtime** includes `messages` and `conversations`.
- **Project Settings → Data API → Exposed schemas** lists `public` (and `graphql_public`)
  but **not** `private`.

### 4. Create the admin account

1. **Authentication → Users → Add user → Create new user.** Enter the admin email and a strong
   password, and tick **Auto Confirm User**. Type the password only in the Supabase dashboard,
   never in chat or a file.
2. **SQL Editor:** open `supabase/snippets/add_admin.sql`, replace `admin@example.com` with
   that email, and run it. The final `select` should show exactly one row.

### 5. Configure the app

```powershell
Copy-Item .env.example .env.local
```

Edit `.env.local` with values from **Project Settings → API Keys** (publishable key) and
**Project Settings → Data API** (project URL):

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

`.env.local` is git-ignored. Do **not** add the secret or service_role key. Phase 1 doesn't use it.

### 6. Run it

```powershell
npm run dev
```

- Customer inbox: <http://localhost:3000>
- Admin: <http://localhost:3000/admin/login>

---

## Verification

### Local checks (no Supabase needed)

```powershell
npm run check
```

This runs ESLint, type generation with `tsc --noEmit`, and `next build`.

### Isolation and Realtime checks (needs the configured project)

```powershell
npm run verify:isolation
```

```powershell
npm run verify:isolation -- --admin
```

The script uses only the publishable key, exactly like a browser. It creates two anonymous
guests, A and B, and checks that:

- each gets its own conversation and `HP-` reference, and repeat or concurrent bootstrap
  reuses the same conversation
- A cannot read B's conversation, messages or customer row, by id, by an unfiltered query,
  or by B's `HP-` reference
- A cannot send into or mark-read B's thread, and direct INSERT, UPDATE or DELETE is denied,
  so a browser cannot forge sender or role
- the sender role and user come from the session, and retries with the same client id don't
  duplicate messages
- a signed-out browser can read and call nothing
- **Realtime:** A receives nothing from B's thread, either unfiltered or with B's conversation
  filter, and vice versa. Positive controls confirm Realtime is delivering.
- with `--admin` (prompts for email and a hidden password, which is never stored): the admin
  sees both threads with unread counts, replies reach only the right guest live, mark-read
  clears counts, and the admin still cannot write directly

The script exits non-zero if any check fails. Test threads start with `[isolation-test]`;
remove them with `supabase/snippets/cleanup_isolation_test_data.sql`.

### Manual browser checks

1. Open <http://localhost:3000> in a normal window and in a private window (or a second
   browser). Send a message from each.
2. In a third browser profile (or the normal window), sign in at `/admin/login`. Both
   conversations should appear with unread badges. Open each one and reply.
3. Each guest should see only its own thread and the admin's reply live.
4. Refresh a guest tab. It should show the same inbox and full history.
5. Reconnect test: in DevTools set **Network → Offline**, have the admin send a reply, then
   go back **Online**. The reply should appear with no duplicates.
6. Same-browser test: with a guest chat open, sign in as admin in another tab of the **same**
   browser, then sign out. The guest tab should keep the same conversation.

---

## Public launch checklist (Phase 4, not done yet)

- [ ] **CAPTCHA for anonymous sign-ins.** Enable Cloudflare Turnstile under
      **Authentication → Attack Protection** and pass the token to `signInAnonymously`.
      (Skipped for the local pilot.)
- [ ] Review **Authentication → Rate Limits**, especially anonymous sign-ins per hour.
- [ ] Decide whether to turn off public email signups. Admin access does not depend on it,
      because only `private.admins` grants access.
- [ ] Enable MFA for the admin account.
- [ ] Set **Authentication → URL Configuration → Site URL** to `https://chat.hpharmacy.pk`.
- [ ] Confirm the Hostinger Node.js runtime (22.x) in hPanel and set the env vars there.
- [ ] Run **Advisors → Security** in the Supabase dashboard and resolve any warnings.
- [ ] Re-run `npm run verify:isolation -- --admin` and the manual checks against the live URL.
- [ ] Backups and restore test (Phase 3).
- [ ] Plan for anonymous-user growth (Supabase Free quotas).

## Not in Phase 1

Image uploads, voice notes, Storage policies, backups, and deployment. The `messages.type`
column already reserves `image` and `audio`, but no function writes them yet.
