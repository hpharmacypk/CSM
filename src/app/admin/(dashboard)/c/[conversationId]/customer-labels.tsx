"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAdminClient } from "../../admin-client-context";
import { LABELS_CHANGED, emitLabelsChanged, fetchLabels, type Label } from "../../admin-data";

/** Assign / remove labels for one customer (admin-only; enforced by RLS). */
export function CustomerLabels({ customerId }: { customerId: string }) {
  const supabase = useAdminClient();
  const [all, setAll] = useState<Label[]>([]);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [labels, { data }] = await Promise.all([
      fetchLabels(supabase),
      supabase.from("customer_labels").select("label_id").eq("customer_id", customerId),
    ]);
    setAll(labels);
    setAssigned(new Set(((data as { label_id: string }[] | null) ?? []).map((r) => r.label_id)));
  }, [supabase, customerId]);

  useEffect(() => {
    queueMicrotask(() => void load());
    const onChange = () => void load();
    window.addEventListener(LABELS_CHANGED, onChange);
    return () => window.removeEventListener(LABELS_CHANGED, onChange);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.target instanceof Element && e.target.closest("[data-labels-editor]")) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const toggle = async (label: Label) => {
    setBusyId(label.id);
    setError(null);
    const has = assigned.has(label.id);
    const { error } = has
      ? await supabase.from("customer_labels").delete().eq("customer_id", customerId).eq("label_id", label.id)
      : await supabase.from("customer_labels").insert({ customer_id: customerId, label_id: label.id });
    setBusyId(null);
    // 23505 = already assigned (e.g. from another tab): treat as success.
    if (error && error.code !== "23505") {
      setError("Couldn't update labels. Try again.");
      return;
    }
    setAssigned((prev) => {
      const next = new Set(prev);
      if (has) next.delete(label.id);
      else next.add(label.id);
      return next;
    });
    emitLabelsChanged();
  };

  const chips = all.filter((l) => assigned.has(l.id));

  return (
    <div className="relative flex flex-wrap items-center gap-1.5" data-labels-editor>
      {chips.map((l) => (
        <span key={l.id} className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand-dark">
          {l.name}
        </span>
      ))}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="rounded-full border border-dashed border-line px-2.5 py-0.5 text-[11px] font-medium text-muted hover:bg-canvas"
      >
        {chips.length ? "Edit labels" : "+ Add label"}
      </button>
      {error ? <span className="text-[11px] text-danger">{error}</span> : null}
      {open ? (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-xl border border-line bg-surface p-2 shadow-lg" role="group" aria-label="Labels for this customer">
          {all.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted">No labels yet.</p>
          ) : (
            <ul className="max-h-64 overflow-y-auto">
              {all.map((l) => (
                <li key={l.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink hover:bg-canvas">
                    <input
                      type="checkbox"
                      checked={assigned.has(l.id)}
                      disabled={busyId !== null}
                      onChange={() => void toggle(l)}
                      className="h-4 w-4 accent-[var(--brand)]"
                    />
                    <span className="truncate">{l.name}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <Link href="/admin/labels" className="mt-1 block rounded-lg px-2 py-1.5 text-xs font-medium text-brand hover:bg-canvas">
            Manage labels →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
