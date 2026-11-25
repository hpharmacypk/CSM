"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  currentSubscription,
  fetchPushConfig,
  isIosDevice,
  isStandaloneApp,
  isSubscribedHere,
  pushSupported,
  registerServiceWorker,
  subscribeHere,
  unsubscribeHere,
} from "@/lib/push/client";
import { HandoffCodeSection } from "./guest-handoff";

export const IOS_INSTALL_INSTRUCTION = "In Safari, tap Share → Add to Home Screen. Open H-Pharmacy from your Home Screen, then tap Get notified when H-Pharmacy replies.";

const BANNER_DISMISSED_KEY = "hp-ios-install-hint-dismissed";

/**
 * iPhone/iPad in the browser (not the Home Screen app): a visible, dismissible
 * banner with the Add to Home Screen steps and the code that keeps this chat.
 * Hidden in the installed app, on other devices, and when push is off.
 */
export function IosInstallBanner({ supabase, onMoved }: { supabase: SupabaseClient; onMoved: () => void }) {
  const [show, setShow] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!isIosDevice() || isStandaloneApp()) return;
      try {
        if (window.localStorage.getItem(BANNER_DISMISSED_KEY) === "1") return;
      } catch {
        // Storage unavailable: still show it.
      }
      const cfg = await fetchPushConfig();
      if (active && cfg.enabled) setShow(true);
    })();
    return () => {
      active = false;
    };
  }, []);

  if (!show) return null;
  return (
    <div className="shrink-0 border-b border-line bg-surface px-3 py-2.5 sm:px-5" data-testid="ios-install-banner">
      <div className="flex items-start gap-2">
        <span aria-hidden className="mt-0.5 text-brand">
          <BellGlyph on={false} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug text-ink" data-testid="ios-banner-instructions">
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
            setShow(false);
            try {
              window.localStorage.setItem(BANNER_DISMISSED_KEY, "1");
            } catch {
              // ignore
            }
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

type View =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "ios-install" }
  | { kind: "unsupported" }
  | { kind: "denied" }
  | { kind: "off" }
  | { kind: "on" };

/**
 * Header control for reply notifications. Permission is requested only when
 * the customer taps "Get notified when H-Pharmacy replies"; a blocked or unsupported browser is
 * explained instead of prompting again.
 */
export function GuestNotificationsButton({ supabase, onMoved }: { supabase: SupabaseClient; onMoved: () => void }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  /** Reads the current state without ever prompting. */
  const refresh = useCallback(async () => {
    const cfg = await fetchPushConfig();
    if (!cfg.enabled) return setView({ kind: "hidden" });
    setPublicKey(cfg.publicKey);
    if (isIosDevice() && !isStandaloneApp()) return setView({ kind: "ios-install" });
    if (!pushSupported()) return setView({ kind: "unsupported" });
    if (Notification.permission === "denied") return setView({ kind: "denied" });
    try {
      await registerServiceWorker();
      if (Notification.permission === "granted") {
        const sub = await currentSubscription();
        return setView({ kind: sub && (await isSubscribedHere(supabase, sub)) ? "on" : "off" });
      }
    } catch {
      // Registration problems surface when the customer taps the control.
    }
    setView({ kind: "off" });
  }, [supabase]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void refresh();
    });
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const turnOn = async () => {
    if (!publicKey || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
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
      setView({ kind: "denied" });
      setBusy(false);
      return;
    }
    if (permission !== "granted") {
      setNotice("Notifications are still off. You can turn them on here any time.");
      setBusy(false);
      return;
    }
    try {
      await subscribeHere(supabase, publicKey);
      setView({ kind: "on" });
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
      await unsubscribeHere(supabase);
      setView({ kind: "off" });
      setNotice("Notifications are off for this chat.");
    } catch {
      setView({ kind: "off" });
      setError("Notifications were turned off on this device, but we couldn't confirm it. Try again if you still get them.");
    }
    setBusy(false);
  };

  if (view.kind === "loading" || view.kind === "hidden") return null;
  const on = view.kind === "on";

  return (
    <div ref={wrapRef} className="relative">
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
        aria-label={on ? "Notifications on" : "Get notified when H-Pharmacy replies"}
        title={on ? "Notifications on" : "Get notified when H-Pharmacy replies"}
        data-testid="notify-button"
        className={`flex h-10 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sm font-medium transition hover:bg-subtle ${
          on ? "text-brand" : "text-muted hover:text-ink"
        }`}
      >
        <BellGlyph on={on} />
        <span className="hidden sm:inline">{on ? "Notifications on" : "Notify me"}</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Reply notifications"
          data-testid="notify-panel"
          className="absolute right-0 top-full z-30 mt-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-2xl border border-line bg-surface p-4 text-left shadow-bubble"
        >
          <PanelBody
            view={view}
            busy={busy}
            onTurnOn={() => void turnOn()}
            onTurnOff={() => void turnOff()}
            supabase={supabase}
            onMoved={onMoved}
          />
          {notice ? (
            <p className="mt-3 text-xs text-muted" role="status">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p className="mt-3 text-xs text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PanelBody({
  view,
  busy,
  onTurnOn,
  onTurnOff,
  supabase,
  onMoved,
}: {
  view: View;
  busy: boolean;
  onTurnOn: () => void;
  onTurnOff: () => void;
  supabase: SupabaseClient;
  onMoved: () => void;
}) {
  const privacy = (
    <p className="mt-2 text-xs leading-relaxed text-muted">
      Notifications only say &ldquo;You have a new reply from H-Pharmacy.&rdquo; Your messages stay in this chat.
    </p>
  );
  switch (view.kind) {
    case "ios-install":
      return (
        <div>
          <p className="text-sm font-semibold text-ink">Get notified on iPhone or iPad</p>
          <p className="mt-1.5 text-sm leading-relaxed text-ink" data-testid="ios-instructions">
            {IOS_INSTALL_INSTRUCTION}
          </p>
          <HandoffCodeSection supabase={supabase} onMoved={onMoved} />
        </div>
      );
    case "unsupported":
      return (
        <div>
          <p className="text-sm font-semibold text-ink">Notifications aren&apos;t available here</p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            This browser can&apos;t show notifications. Your replies will still appear in this chat.
          </p>
        </div>
      );
    case "denied":
      return (
        <div>
          <p className="text-sm font-semibold text-ink">Notifications are blocked</p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            To get notified, allow notifications for this site in your browser or phone settings, then come back
            here.
          </p>
        </div>
      );
    case "on":
      return (
        <div>
          <p className="text-sm font-semibold text-ink">Notifications are on</p>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            We&apos;ll notify this device when H-Pharmacy replies.
          </p>
          {privacy}
          <button
            type="button"
            onClick={onTurnOff}
            disabled={busy}
            data-testid="notify-off"
            className="mt-3 h-10 w-full rounded-full border border-line px-4 text-sm font-semibold text-ink transition hover:bg-subtle disabled:opacity-60"
          >
            {busy ? "Turning off…" : "Turn off notifications"}
          </button>
        </div>
      );
    default:
      return (
        <div>
          <p className="text-sm font-semibold text-ink">Reply notifications</p>
          {privacy}
          <button
            type="button"
            onClick={onTurnOn}
            disabled={busy}
            data-testid="notify-on"
            className="mt-3 h-10 w-full rounded-full bg-brand px-4 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
          >
            {busy ? "Turning on…" : "Get notified when H-Pharmacy replies"}
          </button>
        </div>
      );
  }
}

function BellGlyph({ on }: { on: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" fill="none" />
    </svg>
  );
}
