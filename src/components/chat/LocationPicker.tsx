"use client";

import { useCallback, useEffect, useState } from "react";
import { isValidLocation, type SharedLocation } from "@/lib/chat/use-conversation-messages";
import { formatCoords, googleMapsUrl } from "./LocationCard";
import { MapPicker, type MapPoint } from "./MapPicker";

type Step =
  | { kind: "choose"; error?: string }
  | { kind: "locating" }
  | { kind: "map"; source: "device" | "manual" };

/**
 * "Send location" sheet. Nothing is stored or sent until the user presses
 * Send; Cancel discards the point. Device location is requested only when the
 * user picks "Use current location", once (no tracking).
 */
export function LocationPicker({
  onSend,
  onClose,
}: {
  onSend: (location: SharedLocation) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [point, setPoint] = useState<MapPoint | null>(null);
  const [accuracyM, setAccuracyM] = useState<number | null>(null);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const useCurrent = () => {
    if (typeof window === "undefined" || !window.isSecureContext || !("geolocation" in navigator)) {
      setStep({
        kind: "choose",
        error: "Current location isn't available in this browser. You can choose the point on the map instead.",
      });
      return;
    }
    setStep({ kind: "locating" });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        setPoint({ latitude, longitude });
        setAccuracyM(Number.isFinite(accuracy) ? accuracy : null);
        setStep({ kind: "map", source: "device" });
      },
      (err) => {
        const msg =
          err.code === err.PERMISSION_DENIED
            ? "Location permission was denied. You can still choose the point on the map."
            : err.code === err.TIMEOUT
              ? "Finding your location took too long. Try again, or choose the point on the map."
              : "Your location isn't available right now. You can choose the point on the map.";
        setStep({ kind: "choose", error: msg });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  const chooseOnMap = () => {
    setStep({ kind: "map", source: "manual" });
  };

  const onMapChange = (p: MapPoint) => {
    setPoint(p);
    setAccuracyM(null); // moved by hand: device accuracy no longer applies
  };

  const candidate: SharedLocation | null = point
    ? { latitude: point.latitude, longitude: point.longitude, accuracyM }
    : null;
  const canSend = candidate !== null && isValidLocation(candidate);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="send-location-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[94dvh] w-full max-w-lg flex-col rounded-t-2xl bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 id="send-location-title" className="text-base font-semibold text-ink">
            Send location
          </h2>
          <button type="button" onClick={onClose} className="rounded-full px-3 py-1 text-sm text-muted hover:bg-canvas">
            Cancel
          </button>
        </div>

        {step.kind === "choose" || step.kind === "locating" ? (
          <div className="mt-3 flex flex-col gap-2">
            <p className="text-xs text-muted">
              Share a single point. Your location is not tracked, and nothing is saved until you press Send.
            </p>
            {step.kind === "choose" && step.error ? (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger" role="alert">
                {step.error}
              </p>
            ) : null}
            <button
              type="button"
              onClick={useCurrent}
              disabled={step.kind === "locating"}
              className="flex h-12 items-center justify-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-dark disabled:opacity-60"
            >
              {step.kind === "locating" ? "Finding your location…" : "Use current location"}
            </button>
            <button
              type="button"
              onClick={chooseOnMap}
              className="flex h-12 items-center justify-center rounded-xl border border-line px-4 text-sm font-semibold text-ink hover:bg-canvas"
            >
              Choose on map
            </button>
          </div>
        ) : (
          <div className="mt-3 flex min-h-0 flex-col gap-3">
            <p className="text-xs text-muted">
              {step.source === "device"
                ? "This is your current location. Drag the pin to adjust it if needed."
                : point
                  ? "Drag the pin or tap elsewhere to move it."
                  : "Tap the map to drop a pin."}
            </p>
            <MapPicker value={point} onChange={onMapChange} className="h-[46dvh] min-h-64 w-full sm:h-80" />
            <div className="rounded-xl bg-canvas px-3 py-2 text-sm" aria-live="polite">
              {candidate ? (
                <>
                  <div className="font-mono text-xs text-ink" data-testid="picked-coords">
                    {formatCoords(candidate.latitude, candidate.longitude)}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
                    {accuracyM !== null ? <span>Accuracy about {Math.max(1, Math.round(accuracyM))} m</span> : null}
                    <a
                      href={googleMapsUrl(candidate.latitude, candidate.longitude)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand underline"
                    >
                      Check in Google Maps
                    </a>
                  </div>
                </>
              ) : (
                <span className="text-xs text-muted">No point selected yet.</span>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setPoint(null);
                  setAccuracyM(null);
                  setStep({ kind: "choose" });
                }}
                className="h-10 rounded-full px-3 text-sm text-muted hover:bg-canvas"
              >
                Back
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-10 rounded-full border border-line px-4 text-sm font-medium text-muted hover:bg-canvas"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!canSend}
                  onClick={() => {
                    if (candidate && canSend) {
                      onSend(candidate);
                      onClose();
                    }
                  }}
                  className="h-10 rounded-full bg-brand px-5 text-sm font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
