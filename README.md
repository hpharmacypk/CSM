# H-Pharmacy Customer Inbox

A standalone support inbox for H-Pharmacy. Customers open the site and get a private guest
inbox right away, with no signup, login or OTP. One admin signs in to a separate dashboard,
sees every conversation by recent activity with unread counts, and replies live.

Requirements and phases: [PROJECT_ARCHITECTURE.md](PROJECT_ARCHITECTURE.md).
**Current status: Phase 1 (text chat), Phase 2B (voice notes), Phase 2A (images), and the
unread fix, message deletion, customer profiles and admin labels update, and chat pins,
message pins and location messages.**
Backups and deployment are later phases.

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
supabase/migrations/20261120000100_phase2b_voice_notes.sql private bucket, storage policies, voice sends
supabase/migrations/20261121000100_phase2a_image_messages.sql image types + dimensions on the same bucket/function
src/components/chat/ImagePicker.tsx, ChatImage.tsx          select/preview/send, inline image + viewer
src/lib/chat/image.ts                                      validation, resize, compression, EXIF stripping
supabase/migrations/20261122000100…000400_*.sql            read boundary, deletion, profiles, labels
src/app/guest-profile.tsx, src/components/Avatar.tsx       "My profile" panel, private profile photos
src/app/admin/(dashboard)/labels/                         admin Labels section (/admin/labels)
src/app/admin/(dashboard)/c/[conversationId]/customer-labels.tsx  assign labels in a conversation
supabase/migrations/20261123000100…000300_*.sql            chat pins, message pins, locations
src/components/chat/LocationPicker.tsx, MapPicker.tsx     Send location (Leaflet + OpenStreetMap)
src/components/chat/LocationCard.tsx                      location card + Open in Google Maps
src/components/chat/VoiceRecorder.tsx, VoiceNotePlayer.tsx  record/preview/send, inline playback
src/lib/chat/voice.ts                                      formats, limits, readable errors
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

## Phase 2B: voice notes

Guests and the admin can record a voice note (up to **2 minutes**) with a live timer. They can
stop, preview, discard or send it. Recording stops automatically at 2:00, and the microphone
is released on stop, cancel, or leaving the page. Voice notes appear as inline audio players
in both directions, use the same history, Realtime, unread counts and Retry as text, and
are kept in a **private** Storage bucket. No paid voice API is used.

### How it is secured

| Layer | Rule |
| --- | --- |
| Bucket `chat-media` | Private. Only `audio/webm`, `audio/ogg` and `audio/mp4` are accepted, up to **3 MB** (enforced by Supabase Storage at upload) |
| Object path | `<conversation_id>/<client_message_id>.<webm\|ogg\|m4a>`. Other names are rejected |
| Storage read/upload policies | Same rule as messages: the owning guest or the admin. No overwrite or delete from the browser |
| `send_attachment_message()` | Derives sender and role from the session. Requires the object to exist, be uploaded by the caller, match the message's path, and pass the type, size and duration checks |
| Playback | A 1-hour signed URL, issued only to viewers who pass the Storage read policy (refreshed automatically if it expires) |
| Retries | The same client id is used for the upload path and the message, so a retried send creates **one** message |

### Apply the migration (hosted project)

Migration file: `supabase/migrations/20261120000100_phase2b_voice_notes.sql`

It requires the Phase 1 migration to be applied first. Don't edit the Phase 1 file.

**Option A, SQL Editor:** **SQL Editor → New query** → paste the whole file → **Run**.

**Option B, CLI** (if you linked the project in Phase 1):

```powershell
npx supabase db push
```

Then confirm in the dashboard:

- **Storage → Buckets:** `chat-media` exists and is **Private**. In the bucket settings, the
  file size limit is 3 MB and the allowed MIME types are `audio/webm, audio/ogg, audio/mp4`.
- **Storage → Policies → chat-media:** `chat_media_select` and `chat_media_insert` exist.

No app or `.env.local` changes are needed. Restart `npm run dev` to load the new code.

### Test voice notes

Automated (synthetic audio bytes, no real recordings):

```powershell
npm run verify:isolation -- --admin
```

The voice checks cover:

- upload and send, with one message per retry
- playback after a refresh
- B cannot sign, download, list, upload into or attach A's audio
- no public URL
- non-audio, files over 3 MB and bad file names are rejected at the storage boundary
- no overwrite or delete
- Realtime in both directions
- admin-to-guest voice notes

Manual (real devices, over HTTPS or `localhost`):

1. Guest: tap the **microphone** → allow access → speak about 5 s. The timer counts up. Tap
   **Stop**, play the preview, tap **Send**. It should show "Uploading…" and then the player.
2. Admin: the conversation jumps to the top with an unread badge and the preview
   "Voice note (0:05)". Open it, play it, and reply with a voice note. The guest receives it live.
3. Refresh both sides. Both voice notes should still play.
4. **Denied permission:** block the microphone for the site, then tap the mic. A readable
   "Microphone access is blocked…" message should appear.
5. **Cancel and limit:** cancel mid-recording, and the browser's mic indicator should turn off.
   Record past 2:00, and it should stop by itself with "stopped at the 2-minute limit".
6. **Failed upload:** go offline (DevTools → Network → Offline), send a voice note, and you
   should see "Upload failed… Retry". Go back online, tap **Retry**, and exactly one voice note
   should appear on both sides.
7. Privacy: a second guest (private window) never sees the first guest's voice notes.

Phones can't use the microphone over plain `http://` on your LAN IP. Use an HTTPS tunnel or
the deployed HTTPS site for real-device tests.

### Format support

The recorder picks the first format the browser supports, in this order: AAC in MP4
(`.m4a`, plays everywhere, including iPhone), then Opus in WebM, then Safari's default MP4,
then Opus in Ogg. Players check `canPlayType` first. If a browser can't play a saved format,
the bubble says so and offers **Download to listen**.

| Browser | Records as | Status |
| --- | --- | --- |
| Chromium 156 desktop (the built-in browser) | AAC `audio/mp4` | ✅ verified locally: record, preview, play, 2-min auto-stop (≈1.46 MB), mic release, error messages |
| Same, forced to the WebM/Opus path | `audio/webm` | ✅ verified locally: records and plays. The native player can't show the total length, so the bubble shows its own duration label |
| Android Chrome | AAC MP4 or WebM/Opus, depending on version | ⚠️ not device-tested |
| iPhone/iPad Safari | `audio/mp4` (AAC) | ⚠️ not device-tested. Older iOS versions may be unable to play WebM notes recorded on Android/desktop (the fallback offers a download) |
| Firefox | WebM/Opus or Ogg/Opus | ⚠️ not tested |

Known limitations:

- Uploaded objects can't be deleted from the browser, so a voice note that uploaded but
  whose send was then **discarded** leaves an unreferenced file. A cleanup job belongs
  with backups (Phase 3).
- Test cleanup: `cleanup_isolation_test_data.sql` deletes test threads, but their audio, image and profile-photo
  files stay in Storage. Delete the matching conversation folders in
  **Storage → chat-media** from the dashboard.

## Phase 2A: image messages

Guests and the admin can attach **one JPEG, PNG or WebP image** per message, preview it,
remove it, and send it. Images appear inline in live chat and in saved history, and
tapping one opens a full-size viewer.

**Browser-side preparation** (`src/lib/chat/image.ts`):

- Images are resized to at most **2048 px** on the longest side, which keeps small print
  on boxes and labels readable.
- They're re-encoded as WebP, or JPEG if the browser can't encode WebP. Quality is 0.85
  for photos and 0.92 for PNGs/screenshots. A noisy 12 MP, 5.3 MB photo becomes about 600 KB.
- Re-encoding **removes EXIF metadata** such as phone GPS location, and the photo's
  orientation is applied first.
- Transparent PNG areas become white when JPEG is used.
- Rejected with a readable message: other types (GIF, HEIC, SVG), files over 25 MB,
  images over 50 MP, and corrupt files.

**Storage and database** reuse the voice-note setup in the private `chat-media` bucket:

- The same conversation-scoped access rules and path rule (`.jpg`, `.png` or `.webp`).
- The same `send_attachment_message()` function, now accepting `image`. It requires
  the file extension, the stored file type and the message type to match, the file to be
  at most 3 MB, and valid width/height.
- The same idempotent retry: one message per client ID.
- The conversation list preview reads "Photo".

### Apply the migration (hosted project)

Migration file: `supabase/migrations/20261121000100_phase2a_image_messages.sql`

Apply it **after** `20261120000100_phase2b_voice_notes.sql`. It doesn't modify earlier
files or saved messages. It:

- adds the three image types to the bucket
- adds `attachment_width` and `attachment_height` columns
- extends the path rule
- replaces `send_attachment_message()` with a version that takes optional `p_width` and
  `p_height` (voice-note calls are unchanged)

**SQL Editor:** paste the whole file → **Run**. **Or CLI:**

```powershell
npx supabase db push
```

Then check **Storage → chat-media → bucket settings**: the allowed MIME types should list
the three audio types plus `image/jpeg, image/png, image/webp`, with a 3 MB limit.
Restart `npm run dev`.

### Test images

Automated (a generated 1×1 PNG and synthetic JPEG/WebP bytes):

```powershell
npm run verify:isolation -- --admin
```

The image checks cover:

- PNG, JPEG and WebP sends, with one message per retry
- after a refresh, history contains text, voice and image, and the image bytes load
- B cannot sign, download, list, upload into or attach A's images
- no public URL
- GIF/SVG and files over 3 MB are rejected, and a PNG stored at `.jpg` can't be sent
- live delivery to the sender only
- admin-to-guest images

Manual browser steps:

1. Guest (normal window): tap the **image** button → choose a phone photo of a product
   label. The preview shows the new size, for example "2048×1536 · 640 KB (from 4.1 MB)".
   Try **Remove**, pick it again, then **Send**. It shows "Uploading…" and then the image.
2. Tap the image. The full-size viewer opens; check the small print is readable.
   **Close** or Esc closes it.
3. Admin: the thread shows "Photo" with an unread badge. Open it, view the image, and reply
   with an image of your own. The guest receives it live.
4. Refresh both sides. Text, voice notes and images are all still in history and load.
5. A second guest (private window) sees none of the first guest's images.
6. Offline retry: in DevTools set Network → Offline, send an image, and you should see
   "Upload failed… Retry". Go back online and tap **Retry**. Exactly one image should
   appear on both sides.
7. Try a GIF, which should show "Only JPEG, PNG and WebP images can be sent."
8. Repeat steps 1–4 on an **iPhone** (Safari) and an **Android** phone (Chrome).

What was verified locally (Chromium 156 desktop + 375 px phone width, synthetic images):

- 12 MP → 2048 px WebP, with label small print legible in the viewer
- EXIF/GPS removed
- transparent PNG → WebP keeps transparency; the JPEG fallback puts it on white
- GIF, HEIC and corrupt-file messages
- Remove and Esc
- only one attachment flow open at a time
- text and voice still work
- no horizontal scroll

**Not device-tested:**

- iPhone HEIC photos: Safari normally converts them to JPEG for this picker. If a device
  sends HEIC anyway, the user sees the "Only JPEG, PNG and WebP" message.
- Very large photos on low-memory phones.
- Android camera orientation.
- Firefox.

## Update: unread fix, message deletion, profiles, labels

### Migrations (apply in this order, after the three earlier ones)

1. `supabase/migrations/20261122000100_unread_read_boundary.sql`
2. `supabase/migrations/20261122000200_message_deletion.sql`
3. `supabase/migrations/20261122000300_customer_profiles.sql`
4. `supabase/migrations/20261122000400_admin_labels.sql`

These are forward-only. They don't edit earlier files and don't change any existing message,
customer, read state or media object. This was checked with an upgrade test that loads data
with the old migrations and then applies these four.

**SQL Editor:** run each file in order (paste the whole file → **Run**). **Or CLI:**

```powershell
npx supabase db push
```

Then check in the dashboard:

- **Storage:** a new private bucket `profile-photos` exists (1 MB limit, WebP/JPEG/PNG).
- **Database → Publications → supabase_realtime:** now includes `customers` in addition to
  `messages` and `conversations`. It does **not** include `labels` or `customer_labels`.

Restart `npm run dev`. No `.env.local` changes are needed.

### 1. Unread badge fix

**Cause (reproduced):** the browser called `void supabase.rpc("mark_conversation_read", …)`.
Supabase query builders are lazy, so an un-awaited call never sends a request. A stubbed
`fetch` showed 0 requests. Read state was therefore never saved, and the badge never cleared.

There was also a server-side race. Mark-read always marked everything up to the newest
message, and replying moved the replier's read point past messages they hadn't seen.

**Fix:**

- The thread reports the newest message that is actually on screen: the tab is visible and the
  view is scrolled to the bottom. The app sends that message's `seq` with `p_up_to_seq`, and the
  call is awaited.
- `mark_conversation_read(p_conversation_id, p_up_to_seq)`:
  - takes the same per-conversation lock as sends
  - only moves the read boundary forward, and never past the newest message
  - recomputes the unread count from the messages after the boundary
  - returns the caller's remaining count, which updates the badge immediately

  A message that commits during the call stays unread.
- Sends no longer move the sender's read boundary.
- A background (hidden) tab doesn't mark anything read. Scrolled-up readers see an
  "N new messages" pill instead.
- **Where the counts show:** admin list badges (hidden at 0), the admin tab title, and the
  guest tab title (`(n) H-Pharmacy Support`). Each conversation has its own count.

### 2. Message deletion

Each sent message has a **⋯** menu. It's always visible on touch screens, and appears on hover
or keyboard focus on desktop.

| Option | Who | Effect |
| --- | --- | --- |
| **Delete for me** | Anyone, on any message in their thread | Hidden only for that person, including after refresh and reconnect, and in Realtime. The other side still sees it |
| **Delete for everyone** | The **sender** only, for text, image or voice (no time limit). Asks for confirmation | Content is cleared in the database and both sides see "This message was deleted", live |

Enforced in the database:

- `hide_message_for_me()` and `delete_message_for_everyone()` work out who is acting from the
  login session. An admin can hide a customer's message for themself, but **cannot** delete it
  for everyone.
- Deleted messages no longer count as unread, and the list preview updates.
- Clients refresh the visible window when they reconnect, so deleted or hidden content doesn't
  reappear.

### Retention (current behaviour)

- **Messages** deleted for everyone keep their row (for ordering and history) with the body and
  attachment fields cleared. "Delete for me" adds a row to `message_hidden`. Nothing is
  permanently purged.
- **Media files** are **not deleted** from Storage. Their path is recorded in
  `private.revoked_media`, and Storage refuses any new signed link or download for it,
  for the sender, the other participant and the admin.
- **Signed links issued before the deletion** keep working until they expire. Storage checks
  the link's token, not access rules. The app now issues **10-minute** links (previously
  1 hour), and new uploads are cached for at most 10 minutes. `npm run verify:isolation`
  prints the observed behaviour as an `INFO` line.
- **Profile photos:** replaced or removed photos stay in Storage but are no longer served to
  the admin. Only the customer can read files in their own folder.
- Permanent cleanup of revoked media and old profile photos is **not** part of this change.
  It belongs with backups and retention (Phase 3).

### 3. Customer profile

- Guests get a **My profile** button in the header. They can add, edit or remove a display name
  (up to 60 characters), a short bio (up to 300) and a profile photo. Everything is optional,
  and there's still no login.
- Photos are compressed in the browser (512 px WebP/JPEG, EXIF removed) and stored in the
  private `profile-photos` bucket as `<customer_id>/<random>.ext`.
- The guest header shows their name and photo. The admin sees them in the conversation list
  and thread header, and the **Profile** button shows the bio. With no name set, the
  `HP-` reference is shown instead. Changes reach the admin live.
- Profiles are stored on the existing `customers` row. The customer ID, `HP-` reference, inbox,
  history and labels never change. Writes only go through `update_my_profile`,
  `set_my_avatar` and `remove_my_avatar`. Other guests can read neither the profile nor the
  photo.

### 4. Admin labels

- **Labels** (`/admin/labels`): create, rename and delete labels. Names are trimmed, inner
  spaces are collapsed, and duplicates are blocked ignoring case. Deleting a label removes its
  assignments; chats are untouched.
- **Conversation view:** "+ Add label" / "Edit labels" assigns or removes several labels per
  customer. The same label can't be assigned twice.
- **Conversation list:** shows label chips and has a **Filter by label** menu.
- **Admin-only:** row-level security allows admins only, and neither table is published to
  Realtime, so guests never receive labels.

### Browser test checklist (after applying the migrations)

1. **Unread:**
   - Guest A (normal window) sends two messages. In the admin, the badge shows 2.
   - Open the thread. The badge disappears at once.
   - Refresh the admin page. It stays at 0.
   - Guest A sends again. The badge shows 1, and other threads are unchanged.
2. **Background tab:** keep the admin thread open in a background tab, send from the guest,
   and the badge stays. Switch to the tab and it clears.
3. **Scrolled up:** scroll up in the admin thread, then send from the guest. A
   "1 new message" pill appears and the badge stays until you jump down.
4. **Guest badge:** the admin replies while the guest tab is in the background. The guest tab
   title shows `(1)`. Open the tab and it clears.
5. **Delete for me:** the admin uses Delete for me on a customer message. It disappears for the
   admin only, including after refresh, and the guest still sees it.
6. **Delete for everyone:**
   - The guest deletes their own text, image and voice note for everyone, after confirming.
   - Both sides show "This message was deleted" live, and still do after refresh.
   - In the admin, the customer's messages offer only "Delete for me".
7. **Profile:**
   - The guest opens **My profile**, adds a name, bio and photo, and saves.
   - The guest header and the admin list and thread show them, and **Profile** shows the bio.
   - Remove the photo and clear the name. The admin shows the `HP-` reference again.
   - A second guest (private window) can't see any of it.
8. **Labels:**
   - Create "Pending Order", "Complete" and "Regular Customer". Try "pending order" and
     "  COMPLETE  ", which should be rejected.
   - Assign two labels to a customer, filter the list by each, rename one, then delete one.
     The chats stay.
9. **Regression:** text, image and voice still send, play and survive refresh, and two guests
   still can't see each other's chats.

## Update: chat pins, message pins, location messages

### Migrations (apply in this order, after the seven earlier ones)

1. `supabase/migrations/20261123000100_admin_chat_pins.sql`
2. `supabase/migrations/20261123000200_message_pins.sql`
3. `supabase/migrations/20261123000300_location_messages.sql`

These are forward-only. Earlier files are unchanged, and existing messages, media, profiles,
labels and read state are preserved. This was checked with an upgrade test that loads data
with the seven earlier migrations and then applies these three.

**SQL Editor:** run each file in order. **Or CLI:**

```powershell
npx supabase db push
```

Restart `npm run dev`. There are no new environment variables.

### Map setup: nothing to configure

- **Map:** [Leaflet](https://leafletjs.com) 1.9.4 (BSD-2 licence, npm package) with the public
  **OpenStreetMap** tile server. No API key, account or billing is needed.
- **Tile usage policy:** OpenStreetMap's policy applies. The map credit ("© OpenStreetMap
  contributors") must stay visible, which it is. Use must stay light, with no bulk downloading
  or offline caching, and there's no uptime guarantee. That's fine for a low-traffic pilot. For
  heavy production use, switch to a commercial or self-hosted tile provider; only the tile URL
  in `src/components/chat/MapPicker.tsx` changes.
- **Open in Google Maps:** a plain link
  (`https://www.google.com/maps/search/?api=1&query=lat,lng`), which needs no key and has no cost.
- **Not used:** Google Maps JavaScript API, geocoding (no address lookup), and live tracking.

### 1. Admin chat pins

- In the admin conversation list, each row's **⋯** menu has **Pin chat** / **Unpin chat**.
  Pinned chats get a 📌.
- Pinned chats are listed first, in the main list and when filtering by label. Within each
  group the existing order (newest activity first) is kept.
- Pins are stored in `public.conversation_pins` and shared by all admins. They survive refresh
  and signing in again.
- **Admin-only:** row-level security allows admins only, writes go only through
  `set_conversation_pinned()`, and the table is not published to Realtime. Guests can't see or
  change pins.

### 2. Message pins (shared, one per chat)

- Each message's **⋯** menu has **Pin message** / **Unpin message**, for the guest and the
  admin. Replacing an existing pin asks for confirmation.
- A **Pinned message** banner at the top of both sides stays in sync live and comes back after
  refresh. Tapping it loads any older history needed, scrolls to the original message and
  highlights it. **Unpin** is on the banner.
- `conversations.pinned_message_id` is set only by `pin_message()` and `unpin_message()`. The
  database checks the caller can see the message: same conversation, not deleted, and not
  hidden by the caller.
- The banner's content is always read through the message access rules. **Delete for me** on
  the pinned message hides the banner only for that person. **Delete for everyone** clears the
  pin for both sides.

### 3. Location messages

- The guest and admin composers have a **Send location** button (pin icon). It offers:
  - **Use current location:** device permission is requested only at that moment, with one
    reading and no tracking. If permission is denied, unavailable or too slow, a readable
    message appears and **Choose on map** stays available.
  - **Choose on map:** tap the map to drop a pin, or drag the pin to adjust it.

  The chosen point and its coordinates are shown, with a "Check in Google Maps" link. Nothing
  is saved until you press **Send**, and **Cancel** discards it.
- A single latitude/longitude point (plus device accuracy, if used) is sent with
  `send_location_message()`. It is validated twice: by the function (−90..90 and −180..180,
  rejecting missing values, NaN and ±Infinity) and by table CHECK constraints. Retries are
  idempotent.
- In chat and history, a **location card** shows the coordinates, the accuracy and **Open in
  Google Maps**. Location messages support pin, Delete for me and Delete for everyone; the last
  clears the coordinates and any pin. The list preview reads "Location".

### Fixes found while testing

- **Full-history reload on first connection:** the first Realtime connection re-fetched the
  whole history, up to 1,000 messages, instead of the newest 50. Fixed in
  `use-conversation-messages.ts`.
- **Leaflet credit link:** it opened in the same tab, taking the user out of the chat. It now
  opens in a new tab.

### Browser test checklist (after applying the migrations)

1. **Chat pins:**
   - As admin, use ⋯ → **Pin chat** on an older conversation. It moves to the top with 📌.
   - Refresh, then sign out and in again. It stays pinned.
   - Filter by a label the chat has. It's still listed first.
   - **Unpin chat** returns it to its normal place.
   - The guest sees nothing about chat pins.
2. **Message pins:**
   - The guest pins a message. The admin's open thread shows the same banner live.
   - The admin pins another message, confirms **Replace pin**, and the guest's banner updates.
   - Refresh both sides. The banner is still there.
3. **Older message:** send 60+ messages, pin an early one, refresh, then tap the banner. History
   loads and the view scrolls to the message and highlights it.
4. **Deletion and pins:**
   - Delete for me on the pinned message: the banner disappears only for you.
   - Delete for everyone on the pinned message (by its sender): both banners disappear.
5. **Location, guest to admin:**
   - **Send location → Use current location**, allow permission, check the preview, then
     **Send**. The admin sees the card live, and **Open in Google Maps** opens the right place.
6. **Location, admin to guest:**
   - **Send location → Choose on map**, tap, drag the pin, then **Send**. The guest sees it live
     and after refresh.
7. **Permission denied:** block location for the site, then choose **Use current location**.
   The message appears, and **Choose on map** still works. Check that **Cancel** sends nothing.
8. **Location pin and delete:** pin a location message (the banner reads "Shared location"),
   then delete it for everyone. The card and the banner clear.
9. **Regression:** text, image, voice, profile, labels, unread badges and two-guest isolation
   still work.

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
- [ ] Review map tile usage: public OpenStreetMap tiles are fine for the pilot; move to a
      commercial or self-hosted tile provider if traffic grows (only the tile URL changes).

## Not built yet

Backups (Phase 3) and deployment (Phase 4). A retention/cleanup job is also still needed for
unreferenced attachments (uploaded, then discarded before sending), media of messages deleted
for everyone, and replaced profile photos. It belongs with backups.
