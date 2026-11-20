/** A shared map pin: coordinates + "Open in Google Maps" (plain link, no API key). */
export function googleMapsUrl(lat: number, lng: number) {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

export function formatCoords(lat: number, lng: number) {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(5)}° ${ns}, ${Math.abs(lng).toFixed(5)}° ${ew}`;
}

export function LocationCard({
  latitude,
  longitude,
  accuracyM,
  mine,
}: {
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  mine: boolean;
}) {
  if (latitude === null || longitude === null) {
    return <span className="text-sm italic opacity-80">Location unavailable</span>;
  }
  return (
    <div className="flex w-60 max-w-full flex-col gap-1.5 sm:w-64" data-testid="location-card">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${mine ? "bg-white/20" : "bg-brand-soft"}`}
        >
          <PinIcon />
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold">Shared location</div>
          <div className="truncate font-mono text-[11px] opacity-80">{formatCoords(latitude, longitude)}</div>
        </div>
      </div>
      {accuracyM !== null ? (
        <div className="text-[11px] opacity-80">Accuracy about {Math.max(1, Math.round(accuracyM))} m</div>
      ) : null}
      <a
        href={googleMapsUrl(latitude, longitude)}
        target="_blank"
        rel="noopener noreferrer"
        className={`mt-0.5 inline-flex h-9 items-center justify-center rounded-full px-4 text-sm font-semibold ${
          mine ? "bg-white text-brand-dark hover:bg-white/90" : "bg-brand text-white hover:bg-brand-dark"
        }`}
      >
        Open in Google Maps
      </a>
    </div>
  );
}

function PinIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  );
}
