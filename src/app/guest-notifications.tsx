"use client";

import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BellGlyph, NotificationSheet } from "@/components/NotificationSheet";
import {
  currentSubscription,
  fetchPushConfig,
  hasOptIn,
  isIosDevice,
  isStandaloneApp,
  isSubscribedHere,
  pushSupported,
  registerServiceWorker,
  rememberOptIn,
  showLocalTestNotification,
  subscribeHere,
  unsubscribeHere,
} from "@/lib/push/client";
import { HandoffCodeSection } from "./guest-handoff";

export const OPT_IN_LABEL = "Get notified when H-Pharmacy replies";
export const IOS_INSTALL_INSTRUCTION =
  "In Safari, tap Share → Add to Home Screen. Open H-Pharmacy from your Home Screen, then tap Get notified when H-Pharmacy replies.";

const BANNER_DISMISSED_KEY = "hp-ios-install-hint-dismissed";
const promptKey = (conversationId: string) => `hp-push-prompt-done:${conversationId}`;
const optInKey = (conversationId: string) => `hp-push-optin:${conversationId}`;

export type PushView =
  | "loading"
  | "hidden" // notifications are off on the server
  | "ios-install" // iPhone/iPad in the browser: Add to Home Screen first
  | "unsupported"
  | "denied" // blocked in browser/device settings
  | "off"
  | "on";

/**
 * One owner for the customer's notification state (bell, first-visit prompt,
 * iPhone banner). Never prompts by itself: permission is requested only in
 * turnOn(), which must be called from the customer's tap.
 */
export function useCustomerPush(supabase: SupabaseClient, conversationId: string) {
  const [view, setView] = useState<PushView>("loading");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const cfg = await fetchPushConfig();
    if (!cfg.enabled) return setView("hidden");
    setPublicKey(cfg.publicKey);
    if (isIosDevice() && !isStandaloneApp()) return setView("ios-install");
    if (!pushSupported()) return setView("unsupported");
    if (Notification.permission === "denied") return setView("denied");
    try {
      await registerServiceWorker();
      if (Notification.permission === "granted") {
        const sub = await currentSubscription();
        if (sub && (await isSubscribedHere(supabase, sub))) return setView("on");
        // Opted in before but this device's registration is gone (the
        // browser renewed its subscription, or it expired): register again.
        // Permission is already granted, so this never shows a prompt.
        if (hasOptIn(optInKey(conversationId))) {
          try {
            await subscribeHere(supabase, cfg.publicKey);
            return setView("on");
          } catch {
            // fall through to "off"
          }
        }
      }
    } catch {
      // Registration problems surface when the customer taps the control.
    }
    setView("off");
  }, [supabase, conversationId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void refresh();
    });
    // Back from the settings app / another app: permission may have changed.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const clearMessages = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  /** Call ONLY from a tap: this is where the browser asks for permission. */
  const turnOn = async (): Promise<boolean> => {
    if (!publicKey || busy) return false;
    setBusy(true);
    clearMessages();
    // Ask first, directly in the tap (Safari requires the user gesture).
    let permission: NotificationPermission = Notification.permission;
    if (permission === "default") {
      try {
        permission = await Notification.requestPermission();
      } catch {
        permission = Notification.permission;
      }
    }
    if (permission === "denied") {
      setView("denied");
      setBusy(false);
      return false;
    }
    if (permission !== "granted") {
      setNotice("Notifications are still off. You can turn them on with the bell at any time.");
      setBusy(false);
      return false;
    }
    try {
      await subscribeHere(supabase, publicKey);
      rememberOptIn(optInKey(conversationId), true);
      setView("on");
      setBusy(false);
      return true;
    } catch {
      setError("Couldn't turn on notifications. Try again.");
      setBusy(false);
      return false;
    }
  };

  const turnOff = async () => {
    if (busy) return;
    setBusy(true);
    clearMessages();
    rememberOptIn(optInKey(conversationId), false);
    try {
      await unsubscribeHere(supabase);
      setView("off");
      setNotice("Notifications are off for this chat.");
    } catch {
      setError("Couldn't turn off notifications. Check your connection and try again.");
    }
    setBusy(false);
  };

  const test = async () => {
    clearMessages();
    const shown = await showLocalTestNotification();
    if (shown) {
      setNotice(
        "A test notification was sent from this device. If you don't see it, notifications for this app or browser are turned off in your phone settings.",
      );
    } else {
      setError("This device blocked the test notification. Allow notifications for this app or browser in your settings.");
    }
  };

  return { view, busy, error, notice, refresh, turnOn, turnOff, test, clearMessages };
}

export type CustomerPush = ReturnType<typeof useCustomerPush>;

/** Header bell: always available for later opt-in (or opt-out). */
export function GuestNotificationsButton({
  push,
  supabase,
  onMoved,
}: {
  push: CustomerPush;
  supabase: SupabaseClient;
  onMoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (push.view === "loading" || push.view === "hidden") return null;
  const on = push.view === "on";
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          push.clearMessages();
          if (!open) void push.refresh();
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={on ? "Notifications on" : OPT_IN_LABEL}
        title={on ? "Notifications on" : OPT_IN_LABEL}
        data-testid="notify-button"
        className={`flex h-10 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sm font-medium transition hover:bg-subtle ${
          on ? "text-brand" : "text-muted hover:text-ink"
        }`}
      >
        <BellGlyph on={on} />
        <span className="hidden sm:inline">{on ? "Notifications on" : "Notify me"}</span>
      </button>
      <NotificationSheet open={open} onClose={close} title="Reply notifications" testId="notify-panel">
        <PanelBody push={push} supabase={supabase} onMoved={onMoved} />
      </NotificationSheet>
    </div>
  );
}

function Messages({ push }: { push: CustomerPush }) {
  return (
    <>
      {push.notice ? (
        <p className="mt-3 text-xs leading-relaxed text-muted" role="status">
          {push.notice}
        </p>
      ) : null}
      {push.error ? (
        <p className="mt-3 text-xs leading-relaxed text-danger" role="alert">
          {push.error}
        </p>
      ) : null}
    </>
  );
}

const PRIVACY = "Notifications only say “You have a new reply from H-Pharmacy.” Your messages stay in this chat.";

function PanelBody({ push, supabase, onMoved }: { push: CustomerPush; supabase: SupabaseClient; onMoved: () => void }) {
  let body: React.ReactNode;
  switch (push.view) {
    case "ios-install":
      body = (
        <>
          <p className="mt-1 text-sm leading-relaxed text-ink" data-testid="ios-instructions">
            {IOS_INSTALL_INSTRUCTION}
          </p>
          <HandoffCodeSection supabase={supabase} onMoved={onMoved} />
        </>
      );
      break;
    case "unsupported":
      body = (
        <p className="mt-1 text-sm leading-relaxed text-muted" data-testid="notify-unsupported">
          This browser can&apos;t show notifications. Your replies will still appear in this chat.
        </p>
      );
      break;
    case "denied":
      body = (
        <div data-testid="notify-blocked">
          <p className="mt-1 text-sm font-medium text-ink">Notifications are blocked on this device.</p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            Allow notifications for this site (or the H-Pharmacy app) in your browser or phone settings, then come back
            here.
          </p>
        </div>
      );
      break;
    case "on":
      body = (
        <>
          <p className="mt-1 text-sm leading-relaxed text-muted">We&apos;ll notify this device when H-Pharmacy replies.</p>
          <p className="mt-2 text-xs leading-relaxed text-muted">{PRIVACY}</p>
          <button
            type="button"
            onClick={() => void push.test()}
            data-testid="notify-test"
            className="mt-3 h-10 w-full rounded-full border border-line px-4 text-sm font-medium text-ink transition hover:bg-subtle"
          >
            Show a test notification
          </button>
          <button
            type="button"
            onClick={() => void push.turnOff()}
            disabled={push.busy}
            data-testid="notify-off"
            className="mt-2 h-10 w-full rounded-full border border-line px-4 text-sm font-semibold text-ink transition hover:bg-subtle disabled:opacity-60"
          >
            {push.busy ? "Turning off…" : "Turn off notifications"}
          </button>
        </>
      );
      break;
    default:
      body = (
        <>
          <p className="mt-1 text-xs leading-relaxed text-muted">{PRIVACY}</p>
          <button
            type="button"
            onClick={() => void push.turnOn()}
            disabled={push.busy}
            data-testid="notify-on"
            className="mt-3 min-h-10 w-full rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
          >
            {push.busy ? "Turning on…" : OPT_IN_LABEL}
          </button>
        </>
      );
  }
  return (
    <>
      {body}
      <Messages push={push} />
    </>
  );
}

/**
 * One-time in-app prompt once the chat is ready. Shown only when it can do
 * something useful (opt-in possible, or the iPhone install steps), at most
 * once per chat in this browser ("Not now" / enabling / closing all count).
 */
export function GuestNotifyPrompt({
  push,
  supabase,
  conversationId,
  onMoved,
}: {
  push: CustomerPush;
  supabase: SupabaseClient;
  conversationId: string;
  onMoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const eligible = push.view === "off" || push.view === "ios-install";

  useEffect(() => {
    if (!eligible || hasOptIn(promptKey(conversationId))) return;
    // Let the chat appear first; never on top of the handoff screen (that
    // screen is shown before this component exists).
    const timer = window.setTimeout(() => setOpen(true), 1200);
    return () => window.clearTimeout(timer);
  }, [eligible, conversationId]);

  const done = useCallback(() => {
    rememberOptIn(promptKey(conversationId), true);
    setOpen(false);
  }, [conversationId]);

  if (!open) return null;
  const ios = push.view === "ios-install";
  return (
    <NotificationSheet open onClose={done} title={OPT_IN_LABEL} variant="dialog" testId="notify-prompt">
      {ios ? (
        <>
          <p className="mt-1 text-sm leading-relaxed text-ink" data-testid="prompt-ios-instructions">
            {IOS_INSTALL_INSTRUCTION}
          </p>
          <HandoffCodeSection supabase={supabase} onMoved={onMoved} />
        </>
      ) : (
        <p className="mt-1 text-sm leading-relaxed text-muted">
          We&apos;ll let you know on this device when our team replies. {PRIVACY}
        </p>
      )}
      <Messages push={push} />
      <div className="mt-4 flex flex-col gap-2 sm:flex-row-reverse">
        {ios ? null : (
          <button
            type="button"
            onClick={() => void push.turnOn().then((ok) => ok && done())}
            disabled={push.busy}
            data-testid="prompt-enable"
            className="min-h-10 flex-1 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
          >
            {push.busy ? "Turning on…" : "Turn on notifications"}
          </button>
        )}
        <button
          type="button"
          onClick={done}
          data-testid="prompt-not-now"
          className="min-h-10 flex-1 rounded-full border border-line px-4 py-2 text-sm font-medium text-ink transition hover:bg-subtle"
        >
          Not now
        </button>
      </div>
    </NotificationSheet>
  );
}

/**
 * iPhone/iPad in the browser (not the Home Screen app): a visible, dismissible
 * banner with the Add to Home Screen steps and the code that keeps this chat.
 * Hidden in the installed app, on other devices, and when push is off.
 */
export function IosInstallBanner({
  push,
  supabase,
  onMoved,
}: {
  push: CustomerPush;
  supabase: SupabaseClient;
  onMoved: () => void;
}) {
  const [dismissed, setDismissed] = useState(() => hasOptIn(BANNER_DISMISSED_KEY));
  const [codeOpen, setCodeOpen] = useState(false);
  if (push.view !== "ios-install" || dismissed) return null;
  return (
    <div className="shrink-0 border-b border-line bg-surface px-3 py-2.5 sm:px-5" data-testid="ios-install-banner">
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-0.5 text-brand">
          <BellGlyph on={false} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm leading-snug text-ink" data-testid="ios-banner-instructions">
            {IOS_INSTALL_INSTRUCTION}
          </p>
          {codeOpen ? (
            <HandoffCodeSection supabase={supabase} onMoved={onMoved} />
          ) : (
            <button
              type="button"
              onClick={() => setCodeOpen(true)}
              data-testid="ios-banner-keep-chat"
              className="mt-1 text-xs font-semibold text-brand-ink underline"
            >
              Keep this chat in the app
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="Hide these steps"
          onClick={() => {
            setDismissed(true);
            rememberOptIn(BANNER_DISMISSED_KEY, true);
          }}
          className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-subtle hover:text-ink"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
