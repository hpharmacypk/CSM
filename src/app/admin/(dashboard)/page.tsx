export default function AdminHome() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <span aria-hidden className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface text-brand shadow-bubble">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.1A8 8 0 1 1 20 12z" />
        </svg>
      </span>
      <div>
        <p className="font-semibold text-ink">No conversation selected</p>
        <p className="mt-0.5 text-sm text-muted">Choose a customer from the list to read and reply.</p>
      </div>
    </div>
  );
}
