"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Avatar, PROFILE_BUCKET, customerLabel } from "@/components/Avatar";
import { IMAGE_ACCEPT, ImagePrepError, prepareImage } from "@/lib/chat/image";

export type MyProfile = {
  id: string;
  public_ref: string;
  display_name: string | null;
  bio: string | null;
  avatar_path: string | null;
};

const NAME_MAX = 60;
const BIO_MAX = 300;
const PHOTO_MAX_BYTES = 1024 * 1024;

/** Loads the guest's own customer row (RLS returns only their own). */
export function useMyProfile(supabase: SupabaseClient) {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  useEffect(() => {
    let active = true;
    void supabase
      .from("customers")
      .select("id, public_ref, display_name, bio, avatar_path")
      .maybeSingle()
      .then(({ data }) => {
        if (active && data) setProfile(data as MyProfile);
      });
    return () => {
      active = false;
    };
  }, [supabase]);
  return [profile, setProfile] as const;
}

/** Header button showing the guest's photo/name; opens "My profile". */
export function GuestProfileButton({ supabase }: { supabase: SupabaseClient }) {
  const [profile, setProfile] = useMyProfile(supabase);
  const [open, setOpen] = useState(false);
  if (!profile) return null;
  const label = customerLabel(profile.display_name, null);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-10 min-w-0 shrink-0 items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1 pr-3.5 text-sm font-medium text-ink transition hover:border-line-strong hover:bg-subtle"
        aria-label="My profile"
      >
        <Avatar supabase={supabase} path={profile.avatar_path} label={profile.display_name ?? "You"} size={30} />
        <span className="max-w-[7.5rem] truncate sm:max-w-[10rem]">{profile.display_name ? label : "My profile"}</span>
      </button>
      {open ? (
        <ProfilePanel
          supabase={supabase}
          profile={profile}
          onSaved={setProfile}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ProfilePanel({
  supabase,
  profile,
  onSaved,
  onClose,
}: {
  supabase: SupabaseClient;
  profile: MyProfile;
  onSaved: (p: MyProfile) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(profile.display_name ?? "");
  const [bio, setBio] = useState(profile.bio ?? "");
  const [busy, setBusy] = useState<null | "save" | "photo">(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    },
    [busy, onClose],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("save");
    setMessage(null);
    const { data, error } = await supabase.rpc("update_my_profile", {
      p_display_name: name,
      p_bio: bio,
    });
    setBusy(null);
    if (error || !data) {
      setMessage({ kind: "error", text: error?.message.includes("characters") ? error.message : "Couldn't save your profile. Try again." });
      return;
    }
    const saved = data as MyProfile;
    onSaved(saved);
    setName(saved.display_name ?? "");
    setBio(saved.bio ?? "");
    setMessage({ kind: "ok", text: "Profile saved." });
  };

  const onPhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy("photo");
    setMessage(null);
    try {
      const img = await prepareImage(file, { maxDimension: 512, maxBytes: PHOTO_MAX_BYTES });
      const path = `${profile.id}/${crypto.randomUUID()}.${img.ext}`;
      const up = await supabase.storage
        .from(PROFILE_BUCKET)
        .upload(path, new Blob([img.blob], { type: img.mime }), { contentType: img.mime, upsert: false, cacheControl: "600" });
      if (up.error) throw new Error("Upload failed. Check your connection and try again.");
      const { data, error } = await supabase.rpc("set_my_avatar", { p_path: path });
      if (error || !data) throw new Error("Couldn't save the photo. Try again.");
      onSaved(data as MyProfile);
      setMessage({ kind: "ok", text: "Photo updated." });
    } catch (err) {
      setMessage({
        kind: "error",
        text: err instanceof ImagePrepError || err instanceof Error ? err.message : "Couldn't use that photo.",
      });
    } finally {
      setBusy(null);
    }
  };

  const removePhoto = async () => {
    setBusy("photo");
    setMessage(null);
    const { data, error } = await supabase.rpc("remove_my_avatar");
    setBusy(null);
    if (error || !data) {
      setMessage({ kind: "error", text: "Couldn't remove the photo. Try again." });
      return;
    }
    onSaved(data as MyProfile);
    setMessage({ kind: "ok", text: "Photo removed." });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 backdrop-blur-[2px] sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="my-profile-title"
      onClick={() => !busy && onClose()}
    >
      <form
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-line bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-dialog sm:rounded-2xl"
      >
        <div className="flex items-center justify-between">
          <h2 id="my-profile-title" className="text-lg font-semibold tracking-tight text-ink">
            My profile
          </h2>
          <button type="button" onClick={onClose} disabled={!!busy} className="-mr-2 h-9 rounded-full px-3 text-sm font-medium text-muted transition hover:bg-subtle hover:text-ink">
            Close
          </button>
        </div>
        <p className="mt-1 text-xs text-muted">
          Optional. Only you and the H-Pharmacy team can see this. Your reference stays{" "}
          <span className="font-mono">{profile.public_ref}</span>.
        </p>

        <div className="mt-5 flex items-center gap-4 rounded-2xl border border-line bg-canvas p-3">
          <Avatar supabase={supabase} path={profile.avatar_path} label={profile.display_name ?? "You"} size={72} />
          <div className="flex flex-wrap gap-2">
            <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} className="hidden" onChange={(e) => void onPhoto(e)} data-testid="avatar-input" />
            <button
              type="button"
              disabled={!!busy}
              onClick={() => fileRef.current?.click()}
              className="h-9 rounded-full border border-line bg-surface px-4 text-sm font-medium text-ink transition hover:border-line-strong disabled:opacity-60"
            >
              {busy === "photo" ? "Working…" : profile.avatar_path ? "Change photo" : "Add photo"}
            </button>
            {profile.avatar_path ? (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void removePhoto()}
                className="h-9 rounded-full px-3 text-sm font-medium text-danger transition hover:bg-danger-soft disabled:opacity-60"
              >
                Remove photo
              </button>
            ) : null}
          </div>
        </div>

        <label htmlFor="profile-name" className="mt-5 block text-sm font-semibold text-ink">
          Display name
        </label>
        <input
          id="profile-name"
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Ayesha"
          autoComplete="name"
          className="mt-1 w-full rounded-xl border border-line bg-canvas px-3.5 py-2.5 text-[16px] text-ink outline-none transition placeholder:text-muted/80 hover:border-line-strong focus:border-brand focus:bg-surface focus:ring-3 focus:ring-brand/15"
        />

        <label htmlFor="profile-bio" className="mt-4 block text-sm font-semibold text-ink">
          Short bio
        </label>
        <textarea
          id="profile-bio"
          value={bio}
          maxLength={BIO_MAX}
          rows={3}
          onChange={(e) => setBio(e.target.value)}
          placeholder="Anything that helps us help you, e.g. preferred delivery time."
          className="mt-1 w-full resize-none rounded-xl border border-line bg-canvas px-3.5 py-2.5 text-[16px] text-ink outline-none transition placeholder:text-muted/80 hover:border-line-strong focus:border-brand focus:bg-surface focus:ring-3 focus:ring-brand/15"
        />
        <div className="mt-1 text-right text-[11px] text-muted">
          {bio.length}/{BIO_MAX}
        </div>

        {message ? (
          <p className={`mt-2 text-sm ${message.kind === "ok" ? "text-brand-ink" : "text-danger"}`} role={message.kind === "error" ? "alert" : "status"}>
            {message.text}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          {name || bio ? (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => {
                setName("");
                setBio("");
              }}
              className="h-10 rounded-full px-4 text-sm font-medium text-muted transition hover:bg-subtle hover:text-ink"
            >
              Clear fields
            </button>
          ) : null}
          <button
            type="submit"
            disabled={!!busy}
            className="h-10 rounded-full bg-brand px-6 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
          >
            {busy === "save" ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
