import type { ConnectionState } from "@/lib/chat/use-conversation-messages";

const LABELS = {
  live: { text: "Live", dot: "bg-emerald-500" },
  connecting: { text: "Connecting…", dot: "bg-amber-400" },
  reconnecting: { text: "Reconnecting…", dot: "bg-amber-400" },
} as const;

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  const { text, dot } = LABELS[state];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" role="status">
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {text}
    </span>
  );
}
