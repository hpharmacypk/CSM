import "server-only";

import webpush from "web-push";
import type { PushConfig } from "./config";
import { parsePushEndpoint, resolvesToPublic } from "./endpoint";

export type SendResult = { result: "sent" | "gone" | "retry" | "failed"; error?: string };

/** "reply": staff replied to a customer. "admin": a customer wrote to staff. */
export type PushKind = "reply" | "admin";

/**
 * The encrypted payload carries no message text, names, medication details or
 * identifiers: only which fixed sentence the service worker should show.
 */
const PAYLOADS: Record<PushKind, string> = {
  reply: JSON.stringify({ v: 1, kind: "reply" }),
  admin: JSON.stringify({ v: 1, kind: "admin" }),
};
const TOPICS: Record<PushKind, string> = { reply: "hp-reply", admin: "hp-admin" };
const TIMEOUT_MS = 10_000;
/** A reply notification is only useful for a day; the push service drops it after that. */
const TTL_SECONDS = 24 * 60 * 60;

export async function sendPush(
  cfg: PushConfig,
  sub: { endpoint: string; p256dh: string; auth_secret: string },
  kind: PushKind = "reply",
): Promise<SendResult> {
  const url = parsePushEndpoint(sub.endpoint, cfg.allowLoopbackForTests);
  // An endpoint we will never send to is removed like an expired one.
  if (!url) return { result: "gone", error: "endpoint not allowed" };
  if (!(await resolvesToPublic(url, cfg.allowLoopbackForTests))) {
    return { result: "retry", error: "endpoint host not public" };
  }

  let details: ReturnType<typeof webpush.generateRequestDetails>;
  try {
    details = webpush.generateRequestDetails(
      { endpoint: url.href, keys: { p256dh: sub.p256dh, auth: sub.auth_secret } },
      PAYLOADS[kind],
      {
        vapidDetails: { subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey },
        TTL: TTL_SECONDS,
        urgency: "high",
        // Notifications that wait on the push service collapse into one.
        topic: TOPICS[kind],
        contentEncoding: "aes128gcm",
      },
    );
  } catch {
    // Keys the encryption step cannot use: this subscription can never work.
    return { result: "gone", error: "invalid subscription keys" };
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(details.headers)) {
    if (k.toLowerCase() !== "content-length") headers[k] = String(v);
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: details.body ? new Uint8Array(details.body) : null,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) return { result: "sent" };
    // 404/410: the browser unsubscribed or the subscription expired.
    if (res.status === 404 || res.status === 410) return { result: "gone", error: `HTTP ${res.status}` };
    if (res.status === 413) return { result: "failed", error: "HTTP 413" };
    // 400/401/403 usually mean a VAPID/config problem on our side: retry (a few
    // times) rather than deleting a working subscription. 429/5xx: transient.
    return { result: "retry", error: `HTTP ${res.status}` };
  } catch (error) {
    // Includes a redirect (refused) and timeouts.
    return { result: "retry", error: error instanceof Error ? error.name : "request failed" };
  }
}
