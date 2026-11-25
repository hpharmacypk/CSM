"use client";

import type { SupabaseClient } from "@supabase/supabase-js";

/** Browser helpers for reply notifications. Nothing here asks for permission by itself. */

export const SW_URL = "/sw.js";

export function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support tells them apart.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** True when running as an installed Home Screen app. */
export function isStandaloneApp(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export type PushServerConfig = { enabled: false } | { enabled: true; publicKey: string };

export async function fetchPushConfig(): Promise<PushServerConfig> {
  try {
    const res = await fetch("/api/push/config", { cache: "no-store" });
    if (!res.ok) return { enabled: false };
    const body = (await res.json()) as { enabled?: boolean; publicKey?: string };
    return body.enabled && typeof body.publicKey === "string"
      ? { enabled: true, publicKey: body.publicKey }
      : { enabled: false };
  } catch {
    return { enabled: false };
  }
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  return navigator.serviceWorker.ready;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(sub: PushSubscription, publicKey: string): boolean {
  const current = sub.options?.applicationServerKey;
  if (!current) return true; // older browsers do not expose it
  const a = new Uint8Array(current);
  const b = base64UrlToBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The browser's subscription, if any (no prompt). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Whether this browser's subscription is registered for the current guest chat. */
export async function isSubscribedHere(supabase: SupabaseClient, sub: PushSubscription): Promise<boolean> {
  const { data, error } = await supabase.rpc("push_subscription_active", { p_endpoint: sub.endpoint });
  return !error && data === true;
}

/**
 * This browser's push subscription for our VAPID key (permission must already
 * be granted). Reuses the existing one; replaces it only if it was made with
 * a different key. One browser has ONE subscription for this site, shared by
 * the customer Inbox and the staff dashboard.
 */
export async function subscribeBrowser(publicKey: string): Promise<PushSubscription> {
  const reg = await registerServiceWorker();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
}

export function subscriptionArgs(sub: PushSubscription) {
  const json = sub.toJSON();
  return { p_endpoint: sub.endpoint, p_p256dh: json.keys?.p256dh ?? "", p_auth: json.keys?.auth ?? "" };
}

/**
 * Subscribes this browser and registers it for the current guest chat.
 * Ownership is taken from the session.
 */
export async function subscribeHere(supabase: SupabaseClient, publicKey: string): Promise<void> {
  const sub = await subscribeBrowser(publicKey);
  const { error } = await supabase.rpc("push_subscribe", subscriptionArgs(sub));
  if (error) throw new Error(error.message);
}

/**
 * Stops notifications for this chat on this device. Only the server-side
 * registration is removed: the browser subscription may also be used by the
 * staff dashboard on a shared device, and nothing is sent to it once the
 * registration is gone.
 */
export async function unsubscribeHere(supabase: SupabaseClient): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const { error } = await supabase.rpc("push_unsubscribe", { p_endpoint: sub.endpoint });
  if (error) throw new Error(error.message);
}

/**
 * Shows a notification from this device only (nothing is sent through a push
 * service). If it does not appear, notifications are blocked at device or
 * browser level even though the page may report permission as granted.
 */
export async function showLocalTestNotification(): Promise<boolean> {
  try {
    const reg = await registerServiceWorker();
    await reg.showNotification("H-Pharmacy", {
      body: "Notifications are working on this device.",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      tag: "hp-test",
    });
    return true;
  } catch {
    return false;
  }
}

/** Remembers (per browser) that the customer turned notifications on for a chat. */
export function rememberOptIn(key: string, on: boolean) {
  try {
    if (on) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing to remember.
  }
}

export function hasOptIn(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
