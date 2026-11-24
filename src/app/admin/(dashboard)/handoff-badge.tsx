"use client";

/**
 * Order-agent handoff status for this chat. "Needs staff" when the Agent asked
 * for a person; "Assistant paused" while the Agent is paused after a staff reply.
 * The Agent decides when it resumes; replying here is what pauses it.
 */
export function HandoffBadge({ state, compact = false }: { state: string | null; compact?: boolean }) {
  if (state === "handoff_requested") {
    return (
      <span
        className={`flex shrink-0 items-center gap-1 rounded-full border border-pin/30 bg-pin-soft font-semibold text-pin ${compact ? "px-1.5 py-px text-[11px]" : "h-7 px-2.5 text-xs"}`}
        title="The assistant asked for a team member to take over this chat"
        data-testid="needs-staff-badge"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
        Needs staff
      </span>
    );
  }
  if (state === "human_active" && !compact) {
    return (
      <span
        className="hidden h-7 shrink-0 items-center rounded-full border border-line px-2.5 text-xs font-medium text-muted sm:flex"
        title="The assistant is paused while staff handle this chat"
        data-testid="staff-handling-badge"
      >
        Assistant paused
      </span>
    );
  }
  return null;
}
