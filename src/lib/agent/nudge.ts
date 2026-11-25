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
 * Same idea for notifications: after any message is saved, ask the server to
 * send queued push notifications now (staff reply -> customer devices,
 * customer message -> staff devices). Carries no data.
 */
export function nudgePushQueue() {
  if (typeof window === "undefined") return;
  void fetch("/api/push/nudge", { method: "POST", keepalive: true, cache: "no-store" }).catch(() => undefined);
}

/** Nudges everything that may be waiting on a message the viewer just saved. */
export function nudgeAfterSend(senderRole: "customer" | "admin") {
  void senderRole; // both directions can have queued notifications
  nudgeAgentBridge();
  nudgePushQueue();
}
