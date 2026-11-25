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
 * Subscribes this browser (permission must already be granted) and registers
 * it for the current guest chat. Ownership is taken from the session.
 */
export async function subscribeHere(supabase: SupabaseClient, publicKey: string): Promise<void> {
  const reg = await registerServiceWorker();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
  }
  const json = sub.toJSON();
  const { error } = await supabase.rpc("push_subscribe", {
    p_endpoint: sub.endpoint,
    p_p256dh: json.keys?.p256dh ?? "",
    p_auth: json.keys?.auth ?? "",
  });
  if (error) throw new Error(error.message);
}

/** Removes the registration for this chat and unsubscribes the browser. */
export async function unsubscribeHere(supabase: SupabaseClient): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  const { error } = await supabase.rpc("push_unsubscribe", { p_endpoint: sub.endpoint });
  // Unsubscribe the browser even if the server call failed: the push service
  // then answers 410 and the server removes the row on the next send.
  await sub.unsubscribe().catch(() => undefined);
  if (error) throw new Error(error.message);
}
