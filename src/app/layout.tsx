import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "H-Pharmacy Support",
  description: "Message the H-Pharmacy support team.",
  robots: { index: false, follow: false },
  // No appleWebApp/"web-app-capable" tags on purpose: Home Screen name, icons and
  // full-screen mode come from app/manifest.ts, which only asks for full screen
  // while reply notifications (and the chat handoff they need) are on.
  applicationName: "H-Pharmacy",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Android Chrome: shrink the layout when the keyboard opens so the composer stays visible.
  interactiveWidget: "resizes-content",
  themeColor: "#fffefb",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-dvh">{children}</body>
    </html>
  );
}
