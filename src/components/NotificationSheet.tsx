"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Panel for notification settings and prompts.
 *  - Phones (< 640 px): a bottom sheet over a dimmed backdrop, full width,
 *    safe-area padding, wrapping text, scrolls inside if it is too tall.
 *  - Larger screens: "dropdown" sits under its trigger (the caller wraps the
 *    trigger + sheet in a `relative` element), right-aligned and never wider
 *    than the viewport; "dialog" is centered.
 * Always has a visible close button; Escape and the backdrop close it.
 */
export function NotificationSheet({
  open,
  onClose,
  title,
  variant = "dropdown",
  testId,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  variant?: "dropdown" | "dialog";
  testId?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const dialog = variant === "dialog";
  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        data-testid={testId ? `${testId}-backdrop` : undefined}
        className={`fixed inset-0 z-40 bg-ink/30 ${dialog ? "" : "sm:hidden"}`}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal={dialog || undefined}
        aria-label={title}
        tabIndex={-1}
        data-testid={testId}
        className={[
          // phones: bottom sheet
          "fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-2xl border-t border-line bg-surface text-left shadow-bubble outline-none",
          "pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]",
          // larger screens
          dialog
            ? "sm:inset-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-[26rem] sm:max-w-[calc(100vw-2rem)] sm:max-h-[min(36rem,calc(100dvh-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:p-5"
            : "sm:absolute sm:inset-auto sm:right-0 sm:top-full sm:bottom-auto sm:mt-2 sm:w-80 sm:max-w-[calc(100vw-2rem)] sm:max-h-[min(32rem,calc(100dvh-6rem))] sm:rounded-2xl sm:border sm:p-4",
        ].join(" ")}
      >
        <div aria-hidden className="mx-auto mb-2 h-1 w-10 rounded-full bg-line sm:hidden" />
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 break-words pt-1.5 text-sm font-semibold text-ink">{title}</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid={testId ? `${testId}-close` : undefined}
            className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-subtle hover:text-ink"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="break-words">{children}</div>
      </div>
    </>
  );
}

export function BellGlyph({ on, size = 18 }: { on: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" fill="none" />
    </svg>
  );
}
