"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { Brand } from "@/components/Brand";
import { getAdminBrowserClient } from "@/lib/supabase/admin-browser-client";
import { AdminClientContext } from "./admin-client-context";
import { AdminNotificationsButton, releaseAdminPushBeforeSignOut } from "./admin-notifications";
import { ConversationList } from "./conversation-list";

export function AdminShell({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => getAdminBrowserClient(), []);
  const router = useRouter();
  const pathname = usePathname();
  // On phones the list and the detail pane (thread or Labels) take turns.
  const inThread = pathname !== "/admin";
  const onLabels = pathname.startsWith("/admin/labels");
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    // Stop staff notifications on this device first (shared devices).
    await releaseAdminPushBeforeSignOut(supabase);
    // Local scope: ends this browser's admin session only.
    await supabase.auth.signOut({ scope: "local" });
    router.replace("/admin/login");
    router.refresh();
  };

  return (
    <AdminClientContext value={supabase}>
      <div className="flex h-full flex-col bg-canvas">
        {/* On phones an open chat gets the full screen; its own header has a back button. */}
        <header
          className={`${inThread ? "hidden md:flex" : "flex"} h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:px-4`}
        >
          <Brand subtitle="Support inbox" className="h-10" subtitleOnMobile={false} />
          <nav className="ml-auto flex items-center gap-0.5 rounded-full border border-line bg-canvas p-0.5 text-sm" aria-label="Admin sections">
            <Link
              href="/admin"
              aria-current={!onLabels ? "page" : undefined}
              className={`rounded-full px-3 py-1.5 transition ${!onLabels ? "bg-surface font-semibold text-brand-ink shadow-bubble" : "text-muted hover:text-ink"}`}
            >
              Inbox
            </Link>
            <Link
              href="/admin/labels"
              aria-current={onLabels ? "page" : undefined}
              className={`rounded-full px-3 py-1.5 transition ${onLabels ? "bg-surface font-semibold text-brand-ink shadow-bubble" : "text-muted hover:text-ink"}`}
            >
              Labels
            </Link>
          </nav>
          <AdminNotificationsButton supabase={supabase} />
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            aria-label={signingOut ? "Signing out" : "Sign out"}
            title="Sign out"
            className="flex h-9 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-muted transition hover:bg-subtle hover:text-ink disabled:opacity-60"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" />
            </svg>
            <span className="hidden sm:inline">{signingOut ? "Signing out…" : "Sign out"}</span>
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <aside
            className={`${inThread ? "hidden md:flex" : "flex"} w-full flex-col border-r border-line bg-surface md:w-[22rem] lg:w-96`}
          >
            <ConversationList />
          </aside>
          <section className={`${inThread ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col bg-canvas`}>
            {children}
          </section>
        </div>
      </div>
    </AdminClientContext>
  );
}
