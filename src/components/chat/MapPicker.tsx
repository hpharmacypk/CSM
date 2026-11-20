"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import type { LatLngTuple, Map as LeafletMap, Marker } from "leaflet";

export type MapPoint = { latitude: number; longitude: number };

/** Default view for manual selection: Karachi (H-Pharmacy is in Pakistan). */
const DEFAULT_CENTER: LatLngTuple = [24.8607, 67.0011];
const DEFAULT_ZOOM = 12;
const POINT_ZOOM = 16;

/**
 * Interactive map for choosing one point. Leaflet + OpenStreetMap tiles:
 * no API key or account; OSM's tile usage policy requires the attribution
 * shown in the corner and fair (light) use. Leaflet is loaded in the browser
 * only. Tap the map to place the pin, or drag the pin to adjust it.
 */
export function MapPicker({
  value,
  onChange,
  className = "",
}: {
  value: MapPoint | null;
  onChange: (p: MapPoint) => void;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const onChangeRef = useRef(onChange);
  const initialValue = useRef(value);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    let map: LeafletMap | null = null;
    void import("leaflet").then((L) => {
      if (cancelled || !containerRef.current) return;
      const start = initialValue.current;
      map = L.map(containerRef.current, {
        center: start ? [start.latitude, start.longitude] : DEFAULT_CENTER,
        zoom: start ? POINT_ZOOM : DEFAULT_ZOOM,
        zoomControl: true,
        attributionControl: true,
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
      }).addTo(map);
      // Leaflet's default credit link opens in the same tab, which would take
      // the user out of the chat. Keep the credit, open it in a new tab.
      map.attributionControl.setPrefix(
        '<a href="https://leafletjs.com" target="_blank" rel="noopener noreferrer">Leaflet</a>',
      );

      const icon = L.divIcon({
        className: "hp-map-pin",
        html: '<svg width="34" height="44" viewBox="0 0 24 31" aria-hidden="true"><path d="M12 30s-10-9-10-17a10 10 0 0 1 20 0c0 8-10 17-10 17z" fill="#0f7a5f" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12.5" r="3.6" fill="#fff"/></svg>',
        iconSize: [34, 44],
        iconAnchor: [17, 43],
      });

      const place = (lat: number, lng: number, notify: boolean) => {
        const p = L.latLng(lat, lng).wrap();
        if (!markerRef.current) {
          const marker = L.marker(p, { icon, draggable: true, keyboard: true, title: "Selected location" });
          marker.on("dragend", () => {
            const ll = marker.getLatLng().wrap();
            onChangeRef.current({ latitude: ll.lat, longitude: ll.lng });
          });
          marker.addTo(map as LeafletMap);
          markerRef.current = marker;
        } else {
          markerRef.current.setLatLng(p);
        }
        if (notify) onChangeRef.current({ latitude: p.lat, longitude: p.lng });
      };

      if (start) place(start.latitude, start.longitude, false);
      map.on("click", (e) => place(e.latlng.lat, e.latlng.lng, true));
      mapRef.current = map;
      // The sheet animates open: re-measure once it has its final size.
      window.setTimeout(() => map?.invalidateSize(), 150);
    });
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // Follow external changes (e.g. device location found).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !value) return;
    void import("leaflet").then((L) => {
      const ll = L.latLng(value.latitude, value.longitude);
      if (markerRef.current) {
        const cur = markerRef.current.getLatLng();
        if (cur.lat !== ll.lat || cur.lng !== ll.lng) markerRef.current.setLatLng(ll);
      }
    });
  }, [value]);

  return (
    <div
      ref={containerRef}
      className={`relative z-0 overflow-hidden rounded-xl border border-line bg-canvas ${className}`}
      role="application"
      aria-label="Map. Tap to place the pin, or drag the pin to adjust it."
      data-testid="map-picker"
    />
  );
}
