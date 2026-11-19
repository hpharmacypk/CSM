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

  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-sm"
    >
      <Brand subtitle="Support admin" />
      <h1 className="mt-6 text-lg font-semibold text-ink">Sign in</h1>
      <label className="mt-4 block text-sm font-medium text-ink" htmlFor="email">
        Email
      </label>
      <input
        id="email"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-[16px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
      />
      <label className="mt-4 block text-sm font-medium text-ink" htmlFor="password">
        Password
      </label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-[16px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
      />
      {error ? (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="mt-5 h-11 w-full rounded-lg bg-brand text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-60"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
