"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, customerLabel } from "@/components/Avatar";
import { ChatImage } from "@/components/chat/ChatImage";
import { formatCoords } from "@/components/chat/LocationCard";
import type { DisplayMessage } from "@/lib/chat/use-conversation-messages";
import { MEDIA_BUCKET, formatDuration, isAlreadyUploaded } from "@/lib/chat/voice";
import { nudgeAfterSend } from "@/lib/agent/nudge";
import { useAdminClient } from "../../admin-client-context";
import { runStorageCleanup, type AdminConversationRow } from "../../admin-data";

type Step = "pick" | "confirm-location" | "sending" | "failed";

/**
 * Admin-only "Forward message". Picks a destination chat, shows the recipient
 * and a preview, and sends only after an explicit Forward click (plus an extra
 * confirmation for locations). The destination gets a NEW admin message
 * marked "Forwarded"; images and voice notes are copied inside Storage into
 * the destination's own folder first, so nothing points at the source chat.
 */
export function ForwardDialog({
  message,
  sourceConversationId,
  onClose,
  onForwarded,
}: {
  message: DisplayMessage;
  sourceConversationId: string;
  onClose: () => void;
  onForwarded: (recipient: string) => void;
}) {
  const supabase = useAdminClient();
  const [rows, setRows] = useState<AdminConversationRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("pick");
  const [error, setError] = useState<string | null>(null);
  /** One client id per (message, destination): retries reuse it, so nothing is duplicated. */
  const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void supabase.rpc("admin_list_conversations", {}).then(({ data, error }) => {
      if (!active) return;
      if (error) setLoadError(true);
      else setRows(((data as AdminConversationRow[]) ?? []).filter((r) => r.id !== sourceConversationId));
    });
    searchRef.current?.focus();
    return () => {
      active = false;
    };
  }, [supabase, sourceConversationId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && step !== "sending") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, step]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter(
      (r) => !q || (r.display_name ?? "").toLowerCase().includes(q) || r.public_ref.toLowerCase().includes(q),
    );
  }, [rows, query]);
  const target = rows?.find((r) => r.id === targetId) ?? null;
  const targetName = target ? customerLabel(target.display_name, target.public_ref) : "";
  const isMedia = message.type === "image" || message.type === "audio";

  const choose = (id: string) => {
    if (id === targetId) return;
    setTargetId(id);
    setClientId(crypto.randomUUID()); // new destination → new message id
    setCopiedPath(null);
    setError(null);
    setStep("pick");
  };

  const send = async () => {
    if (!target || !message.id) return;
    setStep("sending");
    setError(null);
    let path: string | null = null;
    if (isMedia) {
      const ext = message.attachmentPath?.match(/\.([a-z0-9]+)$/)?.[1];
      if (!message.attachmentPath || !ext) {
        setError("This attachment can't be forwarded.");
        setStep("failed");
        return;
      }
      path = `${target.id}/${clientId}.${ext}`;
      // A separate private object under the destination chat (never the source path or link).
      const copy = await supabase.storage.from(MEDIA_BUCKET).copy(message.attachmentPath, path);
      if (copy.error && !isAlreadyUploaded(copy.error)) {
        setError("Couldn't copy the attachment. Check your connection and try again.");
        setStep("failed");
        return;
      }
      setCopiedPath(path);
    }
    const { error: rpcError } = await supabase.rpc("admin_forward_message", {
      p_source_message_id: message.id,
      p_target_conversation_id: target.id,
      p_client_message_id: clientId,
      p_attachment_path: path,
    });
    if (rpcError) {
      setError(
        /blocked/i.test(rpcError.message)
          ? `${targetName} is blocked and can't receive messages.`
          : /not available/i.test(rpcError.message)
            ? "This message can no longer be forwarded."
            : "Couldn't forward the message. Try again.",
      );
      setStep("failed");
      return;
    }
    nudgeAfterSend("admin"); // a forward is a staff message in the destination chat
    onForwarded(targetName);
  };

  /** Give up on a failed forward: any copy that never became a message is removed. */
  const discard = async () => {
    if (copiedPath) {
      const { data } = await supabase.rpc("admin_release_unsent_attachment", { p_attachment_path: copiedPath });
      if (data === true) await runStorageCleanup(supabase);
    }
    onClose();
  };

  const forwardClick = () => {
    if (message.type === "location" && step !== "confirm-location") {
      setStep("confirm-location");
      return;
    }
    void send();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 backdrop-blur-[2px] sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="forward-title"
      onClick={() => step !== "sending" && (step === "failed" ? void discard() : onClose())}
    >
      <div
        className="flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-3xl border border-line bg-surface shadow-dialog sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="forward-dialog"
      >
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 id="forward-title" className="text-base font-semibold tracking-tight text-ink">
            Forward message
          </h2>
          <button
            type="button"
            onClick={() => (step === "failed" ? void discard() : onClose())}
            disabled={step === "sending"}
            className="-mr-2 h-9 rounded-full px-3 text-sm font-medium text-muted transition hover:bg-subtle hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
        </div>

        <div className="mx-5 mt-3 rounded-xl border border-line bg-canvas p-3" data-testid="forward-preview">
          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">Message</p>
          <MessagePreview message={message} />
        </div>

        <div className="mt-3 px-5">
          <label htmlFor="forward-search" className="text-sm font-semibold text-ink">
            To
          </label>
          <input
            ref={searchRef}
            id="forward-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or HP reference"
            disabled={step === "sending"}
            className="mt-1.5 w-full rounded-xl border border-line bg-canvas px-3.5 py-2.5 text-[16px] text-ink outline-none transition placeholder:text-muted hover:border-line-strong focus:border-brand focus:bg-surface focus:ring-3 focus:ring-brand/15"
          />
        </div>

        <ul className="hp-scroll mt-2 min-h-24 flex-1 overflow-y-auto px-3" role="listbox" aria-label="Destination chats">
          {loadError ? (
            <li className="px-2 py-4 text-sm text-danger">Couldn&apos;t load chats.</li>
          ) : rows === null ? (
            <li className="px-2 py-4 text-sm text-muted">Loading chats…</li>
          ) : filtered.length === 0 ? (
            <li className="px-2 py-4 text-sm text-muted">No matching chats.</li>
          ) : (
            filtered.map((r) => {
              const name = customerLabel(r.display_name, r.public_ref);
              const blocked = !!r.blocked_at;
              const selected = r.id === targetId;
              return (
                <li key={r.id} role="option" aria-selected={selected} aria-disabled={blocked}>
                  <button
                    type="button"
                    disabled={blocked || step === "sending"}
                    onClick={() => choose(r.id)}
                    className={`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition disabled:cursor-not-allowed ${
                      selected ? "bg-brand-soft ring-1 ring-brand/40" : "hover:bg-subtle"
                    } ${blocked ? "opacity-55" : ""}`}
                  >
                    <Avatar supabase={supabase} path={r.avatar_path} label={name} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">{name}</span>
                      <span className="block truncate font-mono text-[11px] text-muted">{r.public_ref}</span>
                    </span>
                    {blocked ? (
                      <span className="shrink-0 rounded-md bg-danger-soft px-1.5 py-px text-[11px] font-semibold text-danger">Blocked</span>
                    ) : selected ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-brand" aria-hidden>
                        <path d="M5 12l5 5 9-10" />
                      </svg>
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <div className="border-t border-line px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {step === "confirm-location" && target ? (
            <p className="mb-3 rounded-xl border border-pin/25 bg-pin-soft px-3 py-2 text-sm text-ink" role="alert">
              The exact coordinates will be sent to <strong>{targetName}</strong>. Forward this location?
            </p>
          ) : null}
          {error ? (
            <p className="mb-3 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 truncate text-sm text-muted" data-testid="forward-recipient">
              {target ? (
                <>
                  To <span className="font-semibold text-ink">{targetName}</span>
                </>
              ) : (
                "Choose a chat"
              )}
            </p>
            {step === "failed" ? (
              <button
                type="button"
                onClick={() => void discard()}
                className="h-10 shrink-0 rounded-full px-3 text-sm font-medium text-muted hover:bg-subtle"
              >
                Discard
              </button>
            ) : null}
            <button
              type="button"
              disabled={!target || step === "sending"}
              onClick={forwardClick}
              className="h-10 shrink-0 rounded-full bg-brand px-5 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
            >
              {step === "sending"
                ? "Forwarding…"
                : step === "failed"
                  ? "Retry"
                  : step === "confirm-location"
                    ? "Forward location"
                    : "Forward"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessagePreview({ message }: { message: DisplayMessage }) {
  const supabase = useAdminClient();
  switch (message.type) {
    case "image":
      return (
        <div className="flex items-center gap-3">
          <div className="w-20 shrink-0 overflow-hidden rounded-lg">
            <ChatImage supabase={supabase} path={message.attachmentPath} localUrl={null} width={message.width} height={message.height} />
          </div>
          <span className="text-sm text-ink">Photo</span>
        </div>
      );
    case "audio":
      return (
        <p className="text-sm text-ink">
          Voice note{message.durationMs ? ` · ${formatDuration(message.durationMs)}` : ""}
        </p>
      );
    case "location":
      return (
        <p className="text-sm text-ink">
          Shared location
          {message.latitude !== null && message.longitude !== null ? (
            <span className="block font-mono text-xs text-muted">{formatCoords(message.latitude, message.longitude)}</span>
          ) : null}
        </p>
      );
    default:
      return <p className="line-clamp-4 text-sm whitespace-pre-wrap break-words text-ink">{message.body}</p>;
  }
}
