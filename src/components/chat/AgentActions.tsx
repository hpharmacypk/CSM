"use client";

import { useId, useState, type FormEvent } from "react";
import type { AgentActions, AgentChoice, AgentFormField, DeliveryFormValues } from "@/lib/types";

/** "Continue shopping" (hp1:more) only returns focus to the message box. */
export const CONTINUE_SHOPPING_ID = "hp1:more";

export const ASSISTANT_NAME = "H-Pharmacy Assistant";

type Handlers = {
  onChoose: (choice: AgentChoice) => Promise<string | null>;
  onSubmitForm: (values: DeliveryFormValues) => Promise<string | null>;
  onContinueShopping: () => void;
};

/**
 * Buttons, list or delivery form offered with one assistant reply, rendered
 * from the workflow's structured actions (the visible titles are never sent
 * back; the click sends the choice id). Only the current offer is usable.
 */
export function AgentOffer({
  actions,
  usable,
  handlers,
}: {
  actions: AgentActions;
  /** Customer view and this is the current offer. */
  usable: boolean;
  handlers?: Handlers;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const interactive = usable && !!handlers;

  const choose = async (choice: AgentChoice) => {
    if (!handlers || busy) return;
    if (choice.id === CONTINUE_SHOPPING_ID) {
      handlers.onContinueShopping();
      return;
    }
    setBusy(true);
    setError(null);
    const err = await handlers.onChoose(choice);
    setBusy(false);
    setError(err);
  };

  if (actions.kind === "delivery_form" && actions.delivery_form) {
    if (!interactive) {
      return (
        <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-xl border border-dashed border-line-strong px-3 py-1.5 text-xs text-muted" data-testid="agent-form-summary">
          <FormGlyph />
          {usable ? "Delivery form shown to the customer" : "Delivery form requested"}
        </p>
      );
    }
    return (
      <DeliveryForm
        fields={actions.delivery_form.fields}
        title={actions.label ?? "Delivery Form"}
        onSubmit={handlers!.onSubmitForm}
      />
    );
  }

  const choices = actions.choices ?? [];
  if (choices.length === 0) return null;

  if (!interactive) {
    // Admin view, or an older offer: show what was offered, not clickable.
    return (
      <div className="mt-1.5 flex max-w-full flex-wrap gap-1.5" data-testid="agent-choices-readonly" aria-label="Options offered">
        {choices.map((c) => (
          <span key={c.id} className="max-w-full truncate rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted">
            {c.title}
          </span>
        ))}
      </div>
    );
  }

  const buttonClass =
    "min-h-10 max-w-full rounded-full border border-brand/30 bg-surface px-4 py-2 text-left text-sm font-semibold text-brand-ink shadow-bubble transition hover:border-brand hover:bg-brand-soft disabled:opacity-60";

  return (
    <div className="mt-2 flex w-full flex-col items-start gap-1.5" data-testid="agent-choices">
      {actions.kind === "list" ? (
        <>
          <button
            type="button"
            className={buttonClass}
            aria-expanded={listOpen}
            onClick={() => setListOpen((v) => !v)}
            disabled={busy}
          >
            <span className="inline-flex items-center gap-2">
              <ListGlyph />
              {actions.label ?? "View options"}
            </span>
          </button>
          {listOpen ? (
            <ul className="w-full max-w-sm overflow-hidden rounded-2xl border border-line bg-surface shadow-pop" role="list">
              {choices.map((c) => (
                <li key={c.id} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => void choose(c)}
                    disabled={busy}
                    className="block w-full px-4 py-3 text-left text-sm text-ink transition hover:bg-brand-soft disabled:opacity-60"
                  >
                    {c.title}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {choices.map((c) => (
            <button key={c.id} type="button" className={buttonClass} onClick={() => void choose(c)} disabled={busy}>
              {c.title}
            </button>
          ))}
        </div>
      )}
      {busy ? <p className="px-1 text-xs text-muted">Sending…</p> : null}
      {error ? (
        <p className="px-1 text-xs font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const EMPTY: DeliveryFormValues = { full_name: "", shipping_address: "", email_address: "", phone_number: "", city: "" };

const INPUT_PROPS: Record<AgentFormField["key"], { type: string; autoComplete: string; maxLength: number; inputMode?: "tel" | "email" }> = {
  full_name: { type: "text", autoComplete: "name", maxLength: 200 },
  shipping_address: { type: "text", autoComplete: "street-address", maxLength: 500 },
  email_address: { type: "email", autoComplete: "email", maxLength: 200, inputMode: "email" },
  phone_number: { type: "tel", autoComplete: "tel", maxLength: 50, inputMode: "tel" },
  city: { type: "text", autoComplete: "address-level2", maxLength: 200 },
};

const LABELS: Record<AgentFormField["key"], string> = {
  full_name: "Name",
  shipping_address: "Home Address",
  email_address: "Email Address",
  phone_number: "Phone Number",
  city: "City",
};

/** The line n8n builds for the Agent ("Label: value"), for its 1000-character limit. */
function serializedLength(v: DeliveryFormValues): number {
  const parts = (Object.keys(LABELS) as AgentFormField["key"][])
    .filter((k) => v[k].trim())
    .map((k) => `${LABELS[k]}: ${v[k].replace(/\s+/g, " ").trim()}`);
  return parts.join("\n").length;
}

/**
 * The web delivery form. Values stay in this component's memory until sent,
 * are never stored in the browser and never shown back as a chat message.
 * Validation of the details themselves is the Agent's: its errors and the
 * details it already has (present) come back with the next form.
 */
function DeliveryForm({
  fields,
  title,
  onSubmit,
}: {
  fields: AgentFormField[];
  title: string;
  onSubmit: (values: DeliveryFormValues) => Promise<string | null>;
}) {
  const formId = useId();
  const [values, setValues] = useState<DeliveryFormValues>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missing = fields.filter((f) => f.required && !values[f.key].trim());
  const tooLong = serializedLength(values) > 1000;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (missing.length) {
      setError("Please fill in every required field.");
      return;
    }
    if (tooLong) {
      setError("Some details are too long. Please shorten them.");
      return;
    }
    setBusy(true);
    setError(null);
    const err = await onSubmit(values);
    setBusy(false);
    if (err) setError(err);
    else setValues(EMPTY); // drop the details from memory once accepted
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mt-2 w-full max-w-sm rounded-2xl border border-line bg-surface p-4 shadow-bubble"
      aria-labelledby={`${formId}-title`}
      data-testid="delivery-form"
      noValidate
    >
      <h3 id={`${formId}-title`} className="flex items-center gap-2 text-sm font-semibold text-ink">
        <FormGlyph />
        {title}
      </h3>
      <p className="mt-0.5 text-xs text-muted">Shared privately with H-Pharmacy for this order.</p>
      <div className="mt-3 flex flex-col gap-3">
        {fields.map((f) => {
          const id = `${formId}-${f.key}`;
          const p = INPUT_PROPS[f.key];
          const describedBy = [f.error ? `${id}-error` : null, f.present ? `${id}-present` : null].filter(Boolean).join(" ") || undefined;
          return (
            <div key={f.key} className="flex flex-col gap-1">
              <label htmlFor={id} className="text-xs font-semibold text-ink">
                {f.label || LABELS[f.key]}
                {f.required ? <span className="text-danger"> *</span> : <span className="font-normal text-muted"> (optional)</span>}
              </label>
              {f.key === "shipping_address" ? (
                <textarea
                  id={id}
                  name={f.key}
                  rows={2}
                  required={f.required}
                  autoComplete={p.autoComplete}
                  maxLength={p.maxLength}
                  value={values[f.key]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  aria-invalid={f.error ? true : undefined}
                  aria-describedby={describedBy}
                  disabled={busy}
                  className="resize-none rounded-xl border border-line bg-canvas px-3 py-2 text-[16px] leading-6 text-ink outline-none transition focus:border-brand focus:bg-surface focus:ring-3 focus:ring-brand/15 aria-[invalid=true]:border-danger"
                />
              ) : (
                <input
                  id={id}
                  name={f.key}
                  type={p.type}
                  inputMode={p.inputMode}
                  required={f.required}
                  autoComplete={p.autoComplete}
                  maxLength={p.maxLength}
                  value={values[f.key]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  aria-invalid={f.error ? true : undefined}
                  aria-describedby={describedBy}
                  disabled={busy}
                  className="h-11 rounded-xl border border-line bg-canvas px-3 text-[16px] text-ink outline-none transition focus:border-brand focus:bg-surface focus:ring-3 focus:ring-brand/15 aria-[invalid=true]:border-danger"
                />
              )}
              {f.error ? (
                <p id={`${id}-error`} className="text-xs font-medium text-danger">
                  {f.error}
                </p>
              ) : f.present ? (
                <p id={`${id}-present`} className="text-xs text-muted">
                  Already received. Enter it again to confirm.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? (
        <p className="mt-3 text-xs font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="mt-4 h-11 w-full rounded-full bg-brand text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-60"
      >
        {busy ? "Sending…" : "Send delivery details"}
      </button>
    </form>
  );
}

export function AssistantGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <path d="M12 8V5M9 13h.01M15 13h.01M9.5 16h5" />
    </svg>
  );
}

function ListGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  );
}

function FormGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  );
}
