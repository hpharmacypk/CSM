/**
 * Browser hint after a message is saved: asks our server to look for due
 * order-agent events now instead of at the next scheduled run. It carries no
 * data; the events are already stored with the message. Fire-and-forget.
 */
export function nudgeAgentBridge() {
  if (typeof window === "undefined") return;
  void fetch("/api/agent/nudge", { method: "POST", keepalive: true, cache: "no-store" }).catch(() => undefined);
}

/**
 * Same idea for reply notifications: after a staff message is saved, ask the
 * server to send the queued push notifications now. Carries no data.
 */
export function nudgePushQueue() {
  if (typeof window === "undefined") return;
  void fetch("/api/push/nudge", { method: "POST", keepalive: true, cache: "no-store" }).catch(() => undefined);
}

/** Nudges everything that may be waiting on a message the viewer just saved. */
export function nudgeAfterSend(senderRole: "customer" | "admin") {
  nudgeAgentBridge();
  if (senderRole === "admin") nudgePushQueue();
}
