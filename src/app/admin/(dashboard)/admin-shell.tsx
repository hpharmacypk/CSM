"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { Brand } from "@/components/Brand";
import { getAdminBrowserClient } from "@/lib/supabase/admin-browser-client";
import { AdminClientContext } from "./admin-client-context";
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
    // Local scope: ends this browser's admin session only.
    await supabase.auth.signOut({ scope: "local" });
    router.replace("/admin/login");
    router.refresh();
  };

  return (
    <AdminClientContext value={supabase}>
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-3">
          <Brand subtitle="Support inbox" />
          <nav className="ml-auto mr-2 flex items-center gap-1 text-sm" aria-label="Admin sections">
            <Link
              href="/admin"
              aria-current={!onLabels ? "page" : undefined}
              className={`rounded-full px-3 py-1.5 ${!onLabels ? "bg-brand-soft font-semibold text-brand-dark" : "text-muted hover:bg-canvas"}`}
            >
              Inbox
            </Link>
            <Link
              href="/admin/labels"
              aria-current={onLabels ? "page" : undefined}
              className={`rounded-full px-3 py-1.5 ${onLabels ? "bg-brand-soft font-semibold text-brand-dark" : "text-muted hover:bg-canvas"}`}
            >
              Labels
            </Link>
          </nav>
          <button
            type="button"
            onClick={signOut}
            disabled={signingOut}
            className="rounded-full border border-line px-3 py-1.5 text-xs font-medium text-muted hover:bg-canvas disabled:opacity-60"
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <aside
            className={`${inThread ? "hidden md:flex" : "flex"} w-full flex-col border-r border-line bg-surface md:w-80 lg:w-96`}
          >
            <ConversationList />
          </aside>
          <section className={`${inThread ? "flex" : "hidden md:flex"} min-w-0 flex-1 flex-col`}>
            {children}
          </section>
        </div>
      </div>
    </AdminClientContext>
  );
}
