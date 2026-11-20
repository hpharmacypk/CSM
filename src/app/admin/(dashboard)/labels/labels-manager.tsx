"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAdminClient } from "../admin-client-context";
import { LABELS_CHANGED, emitLabelsChanged, fetchLabels, labelErrorMessage, type Label } from "../admin-data";

const MAX = 40;
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

/** Admin-only: create, rename and delete labels (enforced by RLS). */
export function LabelsManager() {
  const supabase = useAdminClient();
  const [labels, setLabels] = useState<Label[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Label | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    const [list, { data }] = await Promise.all([
      fetchLabels(supabase),
      supabase.from("customer_labels").select("label_id"),
    ]);
    const c: Record<string, number> = {};
    for (const r of (data as { label_id: string }[] | null) ?? []) c[r.label_id] = (c[r.label_id] ?? 0) + 1;
    setLabels(list);
    setCounts(c);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    queueMicrotask(() => void load());
    // Assignments changed elsewhere (conversation view, another tab action).
    const onChange = () => void load();
    window.addEventListener(LABELS_CHANGED, onChange);
    return () => window.removeEventListener(LABELS_CHANGED, onChange);
  }, [load]);

  const isDuplicate = (name: string, exceptId?: string) =>
    labels.some((l) => l.id !== exceptId && l.name.toLowerCase() === name.toLowerCase());

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const name = normalize(newName);
    if (!name) return;
    if (isDuplicate(name)) {
      setMessage({ kind: "error", text: `“${name}” already exists.` });
      return;
    }
    setBusy(true);
    const { error } = await supabase.from("labels").insert({ name });
    setBusy(false);
    if (error) {
      setMessage({ kind: "error", text: labelErrorMessage(error) });
      return;
    }
    setNewName("");
    setMessage({ kind: "ok", text: `Label “${name}” created.` });
    await load();
    emitLabelsChanged();
  };

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const name = normalize(editing.name);
    if (!name) return;
    if (isDuplicate(name, editing.id)) {
      setMessage({ kind: "error", text: `“${name}” already exists.` });
      return;
    }
    setBusy(true);
    const { error } = await supabase.from("labels").update({ name }).eq("id", editing.id);
    setBusy(false);
    if (error) {
      setMessage({ kind: "error", text: labelErrorMessage(error) });
      return;
    }
    setEditing(null);
    setMessage({ kind: "ok", text: "Label renamed." });
    await load();
    emitLabelsChanged();
  };

  const remove = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    const { error } = await supabase.from("labels").delete().eq("id", confirmDelete.id);
    setBusy(false);
    const name = confirmDelete.name;
    setConfirmDelete(null);
    if (error) {
      setMessage({ kind: "error", text: "Couldn't delete the label. Try again." });
      return;
    }
    setMessage({ kind: "ok", text: `Label “${name}” deleted. Conversations were not changed.` });
    await load();
    emitLabelsChanged();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <Link href="/admin" className="rounded-full px-2 py-1 text-sm text-brand md:hidden" aria-label="Back to conversations">
          ←
        </Link>
        <div>
          <h1 className="text-sm font-semibold text-ink">Labels</h1>
          <p className="text-xs text-muted">Only visible to admins. Customers never see labels.</p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-xl">
          <form onSubmit={create} className="flex gap-2">
            <label htmlFor="new-label" className="sr-only">
              New label name
            </label>
            <input
              id="new-label"
              value={newName}
              maxLength={MAX}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New label, e.g. Pending Order"
              className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-2.5 text-[16px] outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
            <button
              type="submit"
              disabled={busy || !normalize(newName)}
              className="h-11 shrink-0 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-40"
            >
              Add
            </button>
          </form>

          {message ? (
            <p className={`mt-3 text-sm ${message.kind === "ok" ? "text-brand-dark" : "text-danger"}`} role={message.kind === "error" ? "alert" : "status"}>
              {message.text}
            </p>
          ) : null}

          {loading ? (
            <p className="mt-6 text-sm text-muted">Loading…</p>
          ) : labels.length === 0 ? (
            <p className="mt-6 text-sm text-muted">
              No labels yet. Try “Pending Order”, “Complete” or “Regular Customer”.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-line rounded-xl border border-line bg-surface">
              {labels.map((l) =>
                editing?.id === l.id ? (
                  <li key={l.id} className="p-3">
                    <form onSubmit={rename} className="flex gap-2">
                      <label htmlFor={`rename-${l.id}`} className="sr-only">
                        Rename {l.name}
                      </label>
                      <input
                        id={`rename-${l.id}`}
                        autoFocus
                        value={editing.name}
                        maxLength={MAX}
                        onChange={(e) => setEditing({ id: l.id, name: e.target.value })}
                        className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-2 text-[16px] outline-none focus:border-brand"
                      />
                      <button type="submit" disabled={busy} className="rounded-lg bg-brand px-3 text-sm font-semibold text-white disabled:opacity-40">
                        Save
                      </button>
                      <button type="button" onClick={() => setEditing(null)} className="rounded-lg px-3 text-sm text-muted hover:bg-canvas">
                        Cancel
                      </button>
                    </form>
                  </li>
                ) : (
                  <li key={l.id} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-sm font-medium text-brand-dark">{l.name}</span>
                    <span className="flex-1 text-xs text-muted">
                      {counts[l.id] ?? 0} customer{(counts[l.id] ?? 0) === 1 ? "" : "s"}
                    </span>
                    <button type="button" onClick={() => setEditing({ id: l.id, name: l.name })} className="rounded-lg px-2.5 py-1 text-sm text-ink hover:bg-canvas">
                      Rename
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(l)} className="rounded-lg px-2.5 py-1 text-sm text-danger hover:bg-canvas">
                      Delete
                    </button>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      </div>

      {confirmDelete ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="delete-label-title" onClick={() => !busy && setConfirmDelete(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 id="delete-label-title" className="text-base font-semibold text-ink">
              Delete “{confirmDelete.name}”?
            </h2>
            <p className="mt-1 text-sm text-muted">
              It will be removed from {counts[confirmDelete.id] ?? 0} customer{(counts[confirmDelete.id] ?? 0) === 1 ? "" : "s"}. Conversations
              and messages are not affected.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setConfirmDelete(null)} className="h-10 rounded-full border border-line px-4 text-sm font-medium text-muted hover:bg-canvas">
                Cancel
              </button>
              <button type="button" disabled={busy} onClick={() => void remove()} className="h-10 rounded-full bg-danger px-4 text-sm font-semibold text-white disabled:opacity-60">
                {busy ? "Deleting…" : "Delete label"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
