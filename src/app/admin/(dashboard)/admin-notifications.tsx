"use client";

import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BellGlyph, NotificationSheet } from "@/components/NotificationSheet";
import {
  currentSubscription,
  fetchPushConfig,
  pushSupported,
  registerServiceWorker,
  showLocalTestNotification,
  subscribeBrowser,
  subscriptionArgs,
} from "@/lib/push/client";

const LABEL = "Get notified when customers message";

type View = "loading" | "hidden" | "unsupported" | "denied" | "off" | "on";

/**
 * Removes the signed-in admin's registration for this device. Called before
 * sign-out so the next person using this browser gets no staff notifications.
 * Never blocks sign-out for long.
 */
export async function releaseAdminPushBeforeSignOut(supabase: SupabaseClient): Promise<void> {
  try {
    const work = (async () => {
      const sub = await currentSubscription();
      if (sub) await supabase.rpc("admin_push_unsubscribe", { p_endpoint: sub.endpoint });
    })();
    await Promise.race([work, new Promise((r) => setTimeout(r, 3000))]);
  } catch {
    // Sign-out continues regardless.
  }
}

/** Staff bell: "Get notified when customers message" / "Turn off". */
export function AdminNotificationsButton({ supabase }: { supabase: SupabaseClient }) {
  const [view, setView] = useState<View>("loading");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const close = useCallback(() => setOpen(false), []);

  const refresh = useCallback(async () => {
    const cfg = await fetchPushConfig();
    if (!cfg.enabled) return setView("hidden");
    setPublicKey(cfg.publicKey);
    if (!pushSupported()) return setView("unsupported");
    if (Notification.permission === "denied") return setView("denied");
    try {
      await registerServiceWorker();
      const sub = Notification.permission === "granted" ? await currentSubscription() : null;
      // Also a probe: a database without the staff notification migration has
      // no such function, and then the staff bell stays hidden.
      const { data, error: rpcError } = await supabase.rpc("admin_push_device_state", { p_endpoint: sub?.endpoint ?? "" });
      if (rpcError) return setView("hidden");
      if (!sub) return setView("off");
      if (data === "other") {
        // Another admin used this browser before: stop their notifications here.
        await supabase.rpc("admin_push_release_device", { p_endpoint: sub.endpoint });
        return setView("off");
      }
      setView(data === "mine" ? "on" : "off");
    } catch {
      setView("off");
    }
  }, [supabase]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void refresh();
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const turnOn = async () => {
    if (!publicKey || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    let permission: NotificationPermission = Notification.permission;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = Notification.permission;
      }
    }
    if (permission !== "granted") {
      if (permission === "denied") setView("denied");
      else setNotice("Notifications are still off.");
      setBusy(false);
      return;
    }
    try {
      const sub = await subscribeBrowser(publicKey);
      const { error: rpcError } = await supabase.rpc("admin_push_subscribe", subscriptionArgs(sub));
      if (rpcError) throw rpcError;
      setView("on");
    } catch {
      setError("Couldn't turn on notifications. Try again.");
    }
    setBusy(false);
  };

  const turnOff = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const sub = await currentSubscription();
      if (sub) {
        const { error: rpcError } = await supabase.rpc("admin_push_unsubscribe", { p_endpoint: sub.endpoint });
        if (rpcError) throw rpcError;
      }
      setView("off");
      setNotice("Staff notifications are off on this device.");
    } catch {
      setError("Couldn't turn off notifications. Try again.");
    }
    setBusy(false);
  };

  if (view === "loading" || view === "hidden") return null;
  const on = view === "on";
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setError(null);
          setNotice(null);
          if (!open) void refresh();
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={on ? "Staff notifications on" : LABEL}
        title={on ? "Staff notifications on" : LABEL}
        data-testid="admin-notify-button"
        className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition hover:bg-subtle ${
          on ? "text-brand" : "text-muted hover:text-ink"
        }`}
      >
        <BellGlyph on={on} size={16} />
        <span className="hidden lg:inline">{on ? "Notifications on" : "Notify me"}</span>
      </button>
      <NotificationSheet open={open} onClose={close} title="Staff notifications" testId="admin-notify-panel">
        {view === "unsupported" ? (
          <p className="mt-1 text-sm leading-relaxed text-muted">This browser can&apos;t show notifications.</p>
        ) : view === "denied" ? (
          <div data-testid="admin-notify-blocked">
            <p className="mt-1 text-sm font-medium text-ink">Notifications are blocked on this device.</p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              Allow notifications for this site in your browser or phone settings, then come back here.
            </p>
          </div>
        ) : (
          <>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Notifications only say &ldquo;New customer message.&rdquo; No names or message text. Opening one asks you to
              sign in. Signing out turns them off on this device.
            </p>
            {on ? (
              <>
                <button
                  type="button"
                  onClick={() =>
                    void showLocalTestNotification().then((ok) =>
                      ok
                        ? setNotice("Test shown from this device. If you don't see it, notifications are off in device settings.")
                        : setError("This device blocked the test notification."),
                    )
                  }
                  className="mt-3 h-10 w-full rounded-full border border-line px-4 text-sm font-medium text-ink transition hover:bg-subtle"
                >
                  Show a test notification
                </button>
                <button
                  type="button"
                  onClick={() => void turnOff()}
                  disabled={busy}
                  data-testid="admin-notify-off"
                  className="mt-2 h-10 w-full rounded-full border border-line px-4 text-sm font-semibold text-ink transition hover:bg-subtle disabled:opacity-60"
                >
                  {busy ? "Turning off…" : "Turn off"}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void turnOn()}
                disabled={busy}
                data-testid="admin-notify-on"
                className="mt-3 min-h-10 w-full rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
              >
                {busy ? "Turning on…" : LABEL}
              </button>
            )}
          </>
        )}
        {notice ? (
          <p className="mt-3 text-xs leading-relaxed text-muted" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="mt-3 text-xs leading-relaxed text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </NotificationSheet>
    </div>
  );
}
