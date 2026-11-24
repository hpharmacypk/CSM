import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "H-Pharmacy Support",
  description: "Message the H-Pharmacy support team.",
  robots: { index: false, follow: false },
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
