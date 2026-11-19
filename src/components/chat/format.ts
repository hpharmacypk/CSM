const timeFmt = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en", {
  weekday: "long",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const shortDayFmt = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });

export function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

export function formatDay(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return dayFmt.format(d);
}

/** Compact timestamp for conversation lists. */
export function formatListTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? formatTime(iso) : shortDayFmt.format(d);
}
