"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Brand } from "@/components/Brand";
import { getAdminBrowserClient } from "@/lib/supabase/admin-browser-client";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!isSupabaseConfigured()) {
      setError("Supabase is not configured. Add the settings to .env.local.");
      return;
    }
    setBusy(true);
    // Uses the admin cookie session only; a guest inbox session in this
    // browser (stored separately in localStorage) is left untouched.
    const supabase = getAdminBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setBusy(false);
      setError("Incorrect email or password.");
      return;
    }
    const { data: isAdmin, error: roleError } = await supabase.rpc("am_i_admin");
    if (roleError || isAdmin !== true) {
      await supabase.auth.signOut({ scope: "local" });
      setBusy(false);
      setError("This account does not have admin access.");
      return;
    }
    setPassword("");
    router.replace("/admin");
    router.refresh();
  };

  const field =
    "mt-1.5 w-full rounded-xl border border-line bg-canvas px-3.5 py-2.5 text-[16px] text-ink outline-none transition hover:border-line-strong focus:border-brand focus:bg-surface focus:ring-3 focus:ring-brand/15";

  return (
    <form
      onSubmit={onSubmit}
      className="w-full overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
    >
      <div className="border-b border-line bg-brand-soft/50 px-6 py-5">
        <Brand subtitle="Support inbox" className="h-14" />
      </div>
      <div className="px-6 pt-5 pb-6">
        <h1 className="text-lg font-semibold tracking-tight text-ink">Sign in</h1>
        <p className="mt-0.5 text-sm text-muted">Use your admin account to open the inbox.</p>
        <label className="mt-5 block text-sm font-semibold text-ink" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={field}
        />
        <label className="mt-4 block text-sm font-semibold text-ink" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={field}
        />
        {error ? (
          <p className="mt-4 rounded-xl border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="mt-5 h-11 w-full rounded-xl bg-brand text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </form>
  );
}
