"use client";

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

export const PROFILE_BUCKET = "profile-photos";
const SIGNED_URL_SECONDS = 10 * 60;

/** Name if set, otherwise the HP- reference. */
export function customerLabel(name: string | null | undefined, ref: string | null | undefined) {
  return name?.trim() || ref || "Customer";
}

function initials(text: string) {
  if (/^HP-/.test(text)) return "HP";
  const parts = text.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

/**
 * Profile photo from the private profile-photos bucket (signed URL, only
 * issued to the customer themself or the admin), or initials as fallback.
 * `localUrl` shows a just-picked photo before it is saved.
 */
export function Avatar({
  supabase,
  path,
  localUrl,
  label,
  size = 40,
}: {
  supabase: SupabaseClient;
  path: string | null | undefined;
  localUrl?: string | null;
  label: string;
  size?: number;
}) {
  const [signed, setSigned] = useState<{ path: string; url: string } | null>(null);

  useEffect(() => {
    if (!path || localUrl) return;
    let active = true;
    void supabase.storage
      .from(PROFILE_BUCKET)
      .createSignedUrl(path, SIGNED_URL_SECONDS)
      .then(({ data }) => {
        if (active && data?.signedUrl) setSigned({ path, url: data.signedUrl });
      });
    return () => {
      active = false;
    };
  }, [supabase, path, localUrl]);

  const src = localUrl ?? (signed && signed.path === path ? signed.url : null);
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.38)) };

  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- private signed/blob URL
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      style={style}
      className="shrink-0 rounded-full border border-line bg-surface object-cover"
    />
  ) : (
    <span
      aria-hidden
      style={style}
      className="flex shrink-0 items-center justify-center rounded-full bg-brand-soft font-semibold text-brand-ink"
    >
      {initials(label)}
    </span>
  );
}
