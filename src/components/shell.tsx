"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { DataModeBadge } from "@/components/data-mode";
import { InboxIcon, SearchIcon, SlidersIcon } from "@/components/icons";
import { buttonClass, cx } from "@/components/ui";

/**
 * App shell. The two modes are the only primary destinations: Inbox (push — FINN tells you)
 * and Research (pull — you ask). Rules and settings live behind a header button.
 */

const MODES = [
  { href: "/", label: "Inbox", mode: "Push", icon: InboxIcon, match: (p: string) => p === "/" },
  { href: "/research", label: "Research", mode: "Pull", icon: SearchIcon, match: (p: string) => p.startsWith("/research") },
];

export function AppHeader() {
  const pathname = usePathname() ?? "/";
  const onSettings = pathname.startsWith("/settings");
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur supports-[backdrop-filter]:bg-bg/75" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 lg:px-8">
        <Link href="/" className="flex items-baseline gap-2.5 rounded-md">
          <span className="font-serif text-[24px] font-semibold leading-none tracking-tight">FINN</span>
          <span className="hidden text-[12.5px] text-faint sm:inline">Investor Signal Inbox</span>
        </Link>
        <nav aria-label="Primary" className="ml-6 hidden self-stretch lg:flex">
          <ul className="flex items-stretch gap-1">
            {MODES.map(({ href, label, mode, match }) => {
              const active = match(pathname);
              return (
                <li key={href} className="flex">
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "relative flex items-center gap-2 px-3 text-sm font-medium transition-colors",
                      active ? "text-ink" : "text-muted hover:text-ink",
                    )}
                  >
                    {label}
                    <span className="text-[12px] font-normal text-faint">{mode}</span>
                    {active && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-ink" aria-hidden="true" />}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="ml-auto">
          <DataModeBadge />
        </div>
        <Link
          href="/settings"
          aria-current={onSettings ? "page" : undefined}
          aria-label="Alert rules and settings"
          className={buttonClass("ghost", "sm", "-ml-1 aria-[current=page]:bg-surface-2 aria-[current=page]:text-ink")}
        >
          <SlidersIcon size={17} />
          <span className="sm:hidden">Rules</span>
          <span className="hidden sm:inline">Rules &amp; settings</span>
        </Link>
      </div>
    </header>
  );
}

export function BottomNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav
      aria-label="Modes"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/85 lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="mx-auto flex max-w-md">
        {MODES.map(({ href, label, mode, icon: Icon, match }) => {
          const active = match(pathname);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cx("flex min-h-15 items-center justify-center gap-2.5 py-2 transition-colors", active ? "text-ink" : "text-faint hover:text-muted")}
              >
                <Icon size={21} strokeWidth={active ? 2.1 : 1.7} />
                <span className="flex flex-col leading-tight">
                  <span className="text-[14px] font-semibold">{label}</span>
                  <span className="text-[12px]">{mode}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Standard page frame: consistent gutters, room for the bottom nav on phones. `narrow` keeps a
 * reading measure for single-column pages while staying left-aligned with the header.
 */
export function PageFrame({ children, narrow = false }: { children: ReactNode; narrow?: boolean }) {
  return (
    <main id="main" className="mx-auto w-full max-w-6xl px-4 pb-32 pt-5 lg:px-8 lg:pb-16 lg:pt-8">
      {narrow ? <div className="max-w-3xl">{children}</div> : children}
    </main>
  );
}
