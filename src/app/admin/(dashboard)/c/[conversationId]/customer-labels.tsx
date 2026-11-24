"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAdminClient } from "../../admin-client-context";
import { LabelChip } from "../../conversation-list";
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
        <LabelChip key={l.id}>{l.name}</LabelChip>
      ))}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className="inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-line-strong px-2 text-[11px] font-medium text-muted transition hover:border-brand hover:text-brand"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
          {chips.length ? <path d="M4 20h4L19 9l-4-4L4 16z" /> : <path d="M12 5v14M5 12h14" />}
        </svg>
        {chips.length ? "Edit labels" : "Add label"}
      </button>
      {error ? <span className="text-[11px] text-danger">{error}</span> : null}
      {open ? (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-xl border border-line bg-surface p-2 shadow-pop" role="group" aria-label="Labels for this customer">
          {all.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted">No labels yet.</p>
          ) : (
            <ul className="max-h-64 overflow-y-auto">
              {all.map((l) => (
                <li key={l.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-ink transition hover:bg-subtle">
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
          <Link href="/admin/labels" className="mt-1 block rounded-lg border-t border-line px-2 pt-2 pb-1.5 text-xs font-semibold text-brand hover:bg-subtle">
            Manage labels →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
