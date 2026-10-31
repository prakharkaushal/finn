import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import { Suspense } from "react";
import { DataModeBanner } from "@/components/data-mode-banner";
import { AppHeader, BottomNav } from "@/components/shell";
import { SettingsProvider } from "@/components/settings-provider";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const newsreader = Newsreader({ variable: "--font-newsreader", subsets: ["latin"], axes: ["opsz"] });

export const metadata: Metadata = {
  title: { default: "FINN — Investor Signal Inbox", template: "%s · FINN" },
  description: "What changed in your portfolio, why it matters, and the filing that proves it.",
  applicationName: "FINN",
  appleWebApp: { capable: true, title: "FINN", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f1" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1012" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" className={`${geistSans.variable} ${geistMono.variable} ${newsreader.variable} h-full antialiased`}>
      <body className="min-h-full">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-3 focus:py-2 focus:text-bg">
          Skip to content
        </a>
        <SettingsProvider>
          {/* The header and tab bar highlight the current mode from the URL (known at request time). */}
          <Suspense fallback={<div className="h-14 border-b border-line" />}>
            <AppHeader />
          </Suspense>
          <DataModeBanner />
          {children}
          <Suspense fallback={null}>
            <BottomNav />
          </Suspense>
        </SettingsProvider>
      </body>
    </html>
  );
}
