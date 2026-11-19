export function Brand({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand text-lg font-bold text-white"
      >
        +
      </div>
      <div className="leading-tight">
        <div className="text-base font-semibold text-ink">H-Pharmacy</div>
        {subtitle ? <div className="text-xs text-muted">{subtitle}</div> : null}
      </div>
    </div>
  );
}
