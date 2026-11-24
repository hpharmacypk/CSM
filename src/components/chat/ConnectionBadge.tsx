import type { ConnectionState } from "@/lib/chat/use-conversation-messages";

const LABELS = {
  live: { text: "Live", dot: "bg-emerald-500" },
  connecting: { text: "Connecting…", dot: "bg-amber-400 animate-pulse" },
  reconnecting: { text: "Reconnecting…", dot: "bg-amber-400 animate-pulse" },
} as const;

/** `compact` hides the "Live" text (dot only) but always shows connection problems. */
export function ConnectionBadge({ state, compact = false }: { state: ConnectionState; compact?: boolean }) {
  const { text, dot } = LABELS[state];
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted" role="status" title={text}>
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
      <span className={compact && state === "live" ? "sr-only" : ""}>{text}</span>
    </span>
  );
}
