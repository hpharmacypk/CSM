import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { getPushConfig } from "@/lib/push/config";

/**
 * Web app manifest: lets customers add the Inbox to their Home Screen
 * (required for notifications on iPhone/iPad) and open it full screen.
 *
 * Full-screen ("standalone") is offered only while reply notifications are on.
 * On iPhone/iPad a standalone Home Screen app has its own storage, so it needs
 * the chat handoff that comes with the notifications feature; with it off, a
 * Home Screen shortcut keeps opening in the browser with the existing chat.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  await connection(); // read the server setting per request, not at build time
  const standalone = getPushConfig().enabled;
  return {
    id: "/",
    name: "H-Pharmacy Support",
    short_name: "H-Pharmacy",
    description: "Message the H-Pharmacy support team.",
    start_url: "/",
    scope: "/",
    display: standalone ? "standalone" : "browser",
    orientation: "portrait",
    background_color: "#fffefb",
    theme_color: "#fffefb",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
