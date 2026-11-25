# H-Pharmacy Customer Inbox

## Purpose

Build a standalone web inbox where customers can contact one H-Pharmacy support admin. Customers open the website and immediately get a private guest inbox. There is no customer signup, login, or OTP screen. The admin signs in to a separate dashboard and can view and reply to every conversation.

The full release supports live text messages, images, and recorded voice notes in both directions. The existing WooCommerce website can link to the inbox after launch.

## Customer and admin behavior

- On first visit, create a Supabase anonymous session and give that guest a unique customer ID and one inbox. Use the authenticated guest identity to control access. The customer ID is a reference, not an access credential.
- Reuse the inbox on refresh and repeat visits while the browser session is available. A different device, browser, or cleared session creates a new inbox. The original conversation remains visible to the admin.
- Save the full conversation, including timestamps and attachment references, in its original thread. The pilot has no scheduled history deletion.
- The admin dashboard lists conversations by recent activity and shows unread counts. The admin opens a thread, reads its history, and replies. Guests cannot read other threads, files, or live events.

## Architecture

| Component | Responsibility |
| --- | --- |
| Next.js and TypeScript | Guest inbox, protected admin dashboard, and application routes |
| Supabase Auth | Anonymous guest identities and a dedicated admin login |
| Supabase PostgreSQL | Customer IDs, conversations, messages, attachment references, and read state |
| Supabase Realtime | Authorized browser subscriptions for live updates. Clients reload missed messages after reconnecting |
| Supabase Storage | Private image and audio objects with conversation-based access |
| Hostinger Business | Preferred production runtime for the Next.js Node.js Web App at `https://rounded-ghostwhite-pigeon-89.hostingersite.com` (permanent Inbox address) |

Browsers connect directly to Supabase for live events and scoped media uploads. Voice note recording uses the browser microphone over HTTPS. The first media release compresses images and caps recordings at two minutes. The pilot uses Supabase Free. Hosting and backup may have no additional monthly fee if existing capacity is sufficient. Review usage as the history grows and revisit paid capacity when needed.

## Data model and access

- A customer record links its public reference ID to the Supabase Auth identity. Enforce one conversation per guest identity in the database so refreshes and concurrent tabs can safely reuse it.
- Each message belongs to one conversation and records sender, message type, content or attachment reference, and creation time. Persist read state for unread counts. Use stable ordering when loading earlier history.
- Store the admin role in a server-controlled location. Allow admin access only to the designated account. Privileged credentials stay server-side and outside Git.
- Apply Row Level Security and server-side authorization to thread and message operations. Realtime and Storage must enforce the same access boundaries. Treat sender and conversation values supplied by the browser as untrusted.
- Media objects live in private storage. A recipient loads an attachment only after authorization. Handle upload or send failure without leaving a visible broken message or duplicating a message on retry.

## What we need

| When | Requirements |
| --- | --- |
| Before local build | Windows project folder open in Claude Code, Node.js and npm compatible with the intended Hostinger runtime, and Git for local version control |
| For local integration | Dedicated Supabase Free project, project URL, publishable key, anonymous sign-ins enabled, SQL migrations applied, and one admin account created by the project owner |
| For backup and deployment | Secure backup destination outside the live Supabase project, a scheduler if backups will be automatic, Hostinger hPanel and subdomain access, HTTPS, and deployment environment variables |

Provide `.env.example` with placeholders and a README with exact setup steps. Keep passwords and private keys out of Claude chat and Git. The initial scaffold and migrations can be prepared before a Supabase project is configured.

## Implementation phases

| Phase | Deliverable | Completion check |
| --- | --- | --- |
| 0. Planning | Inspect the selected folder and local tools. Propose routes, schema, access policies, prerequisites, and the Phase 1 work plan | Owner reviews any assumptions and approves Phase 1 |
| 1. Local text chat | Next.js scaffold, SQL migrations, guest session, admin login, text messaging, Realtime, unread counts, and history | Two independent guest sessions each see only their own chat. Admin can view and reply to both. Refresh and reconnect recover messages |
| 2. Media | Image uploads and previews, plus voice recording, sending, and playback for both roles | Verify mobile recording, denied microphone permission, upload retry, and attachment isolation |
| 3. Backup and recovery | Export database and necessary identity data. Copy private media independently and preserve its relationship to the database snapshot | Restore into an isolated test environment and verify chat, permissions, and playback |
| 4. Hostinger launch | Deploy the app on the supported plan over HTTPS. Set environment variables and verify the live app before linking it from WooCommerce | Repeat isolation, admin and media checks on the live URL |

Start with Phase 0 only. Report missing tools, account setup, and unresolved decisions. Leave production changes, deployments, and paid purchases for their relevant phases.
