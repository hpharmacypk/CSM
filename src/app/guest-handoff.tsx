"use client";

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * iPhone/iPad keep a Home Screen app's storage apart from Safari, so the
 * installed app does not have the Safari chat session. The customer moves the
 * chat with a one-time code (never a token in a URL): Safari shows the code,
 * the app asks for it once. The server moves the chat to the app's session.
 */

const POLL_MS = 4000;

/** Safari side: get a one-time code; notices when the app has taken the chat. */
export function HandoffCodeSection({ supabase, onMoved }: { supabase: SupabaseClient; onMoved: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!code) return;
    const timer = window.setInterval(async () => {
      if (expiresAt && Date.now() > expiresAt) {
        setCode(null);
        return;
      }
      const { data } = await supabase.rpc("guest_handoff_moved");
      if (data === true) onMoved();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [code, expiresAt, supabase, onMoved]);

  const getCode = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    const { data, error: rpcError } = await supabase.rpc("create_guest_handoff");
    setBusy(false);
    const result = data as { code?: string; expires_at?: string } | null;
    if (rpcError || !result?.code) {
      setError("Couldn't create a code. Try again.");
      return;
    }
    setCode(result.code);
    setExpiresAt(result.expires_at ? Date.parse(result.expires_at) : null);
  };

  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="text-xs leading-relaxed text-muted">
        To keep this chat in the app, get a code here and enter it when the app opens.
      </p>
      {code ? (
        <div className="mt-2 rounded-xl bg-brand-soft px-3 py-2 text-center" data-testid="handoff-code-box">
          <p className="font-mono text-xl font-bold tracking-[0.2em] text-brand-ink" data-testid="handoff-code">
            {code}
          </p>
          <p className="mt-0.5 text-[11px] text-brand-ink/80">Works once, for 20 minutes. Don&apos;t share it.</p>
          <button
            type="button"
            className="mt-1 text-xs font-semibold text-brand-ink underline"
            onClick={() => {
              void navigator.clipboard?.writeText(code).then(
                () => setCopied(true),
                () => undefined,
              );
            }}
          >
            {copied ? "Copied" : "Copy code"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void getCode()}
          disabled={busy}
          data-testid="handoff-get-code"
          className="mt-2 h-9 w-full rounded-full border border-line px-4 text-sm font-semibold text-ink transition hover:bg-subtle disabled:opacity-60"
        >
          {busy ? "Getting code…" : "Get a code for the app"}
        </button>
      )}
      {error ? (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const REASONS: Record<string, string> = {
  invalid: "That code didn't work. Check it, or get a new code in Safari.",
  rate_limited: "Too many tries. Wait 15 minutes, or start a new chat.",
  has_chat: "This app already has a chat with messages, so it can't take another one.",
};

/** Home Screen app, first open: continue the Safari chat with its code, or start fresh. */
export function HandoffEntry({
  supabase,
  onContinue,
  onStartNew,
}: {
  supabase: SupabaseClient;
  onContinue: () => void;
  onStartNew: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { data: s } = await supabase.auth.getSession();
      if (!s.session) {
        const { error: signInError } = await supabase.auth.signInAnonymously();
        if (signInError) throw signInError;
      }
      const { data, error: rpcError } = await supabase.rpc("redeem_guest_handoff", { p_code: code });
      const result = data as { ok?: boolean; reason?: string } | null;
      if (rpcError || !result) throw rpcError ?? new Error("no result");
      if (result.ok) {
        onContinue();
        return;
      }
      setError(REASONS[result.reason ?? ""] ?? REASONS.invalid);
    } catch {
      setError("Couldn't check the code. Check your connection and try again.");
    }
    setBusy(false);
  };

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center p-6">
      <form onSubmit={(e) => void submit(e)} className="flex w-full max-w-sm flex-col gap-3 text-center" data-testid="handoff-entry">
        <h1 className="text-lg font-semibold tracking-tight text-ink">Continue your chat</h1>
        <p className="text-sm leading-relaxed text-muted">
          Started a chat in Safari? Enter the code shown there (&ldquo;Keep this chat in the app&rdquo;, or
          the bell, then &ldquo;Get a code for the app&rdquo;).
        </p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 9))}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          autoCorrect="off"
          spellCheck={false}
          placeholder="ABCD-EFGH"
          aria-label="Code from Safari"
          data-testid="handoff-input"
          className="h-12 rounded-xl border border-line bg-surface px-4 text-center font-mono text-lg tracking-[0.2em] text-ink outline-none focus:border-brand"
        />
        {error ? (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy || code.replace(/[^A-Za-z0-9]/g, "").length !== 8}
          data-testid="handoff-submit"
          className="h-11 rounded-full bg-brand px-6 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
        >
          {busy ? "Checking…" : "Continue chat"}
        </button>
        <button
          type="button"
          onClick={onStartNew}
          disabled={busy}
          data-testid="handoff-start-new"
          className="h-10 rounded-full px-4 text-sm font-medium text-muted transition hover:bg-subtle hover:text-ink"
        >
          Start a new chat instead
        </button>
      </form>
    </main>
  );
}

/** Safari side after the app took the chat over. */
export function MovedNotice({ onStartNew }: { onStartNew: () => void }) {
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3" data-testid="moved-view">
        <h1 className="text-lg font-semibold tracking-tight text-ink">Your chat is now in the H-Pharmacy app</h1>
        <p className="text-sm leading-relaxed text-muted">
          Open H-Pharmacy from your Home Screen to continue. New replies arrive there.
        </p>
        <button
          type="button"
          onClick={onStartNew}
          className="mt-1 h-10 rounded-full px-4 text-sm font-medium text-muted transition hover:bg-subtle hover:text-ink"
        >
          Start a new chat in this browser
        </button>
      </div>
    </main>
  );
}
