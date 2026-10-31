"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_ALERT_CATEGORIES, isCategory, type Category } from "@/lib/domain/categories";
import { DEFAULT_THRESHOLDS, type Thresholds } from "@/lib/domain/signals";
import { WINDOWS, type WindowKey } from "@/lib/inbox/types";
import { DEFAULT_PORTFOLIO, MAX_PORTFOLIO } from "@/lib/portfolio";

/** Per-device preferences. Nothing here is sensitive; it never leaves the browser except as query params. */
export type Settings = {
  portfolio: string[];
  windowKey: WindowKey;
  thresholds: Thresholds;
  alertCategories: Category[];
};

export const DEFAULT_SETTINGS: Settings = {
  portfolio: DEFAULT_PORTFOLIO.map((p) => p.symbol),
  windowKey: "24h",
  thresholds: DEFAULT_THRESHOLDS,
  alertCategories: DEFAULT_ALERT_CATEGORIES,
};

const SETTINGS_KEY = "finn.settings.v1";
const DONE_KEY = "finn.done.v1";
const DONE_TTL_MS = 30 * 86_400_000;

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked (private mode, quota): settings still work for this session.
  }
}

function sanitize(raw: Partial<Settings> | null): Settings {
  if (!raw) return DEFAULT_SETTINGS;
  const portfolio = Array.isArray(raw.portfolio)
    ? [...new Set(raw.portfolio.filter((s): s is string => typeof s === "string" && /^[A-Z0-9&-]{1,20}$/.test(s)))].slice(0, MAX_PORTFOLIO)
    : DEFAULT_SETTINGS.portfolio;
  const t = raw.thresholds;
  return {
    portfolio,
    windowKey: raw.windowKey && raw.windowKey in WINDOWS ? raw.windowKey : DEFAULT_SETTINGS.windowKey,
    thresholds: {
      pricePct: typeof t?.pricePct === "number" ? t.pricePct : DEFAULT_THRESHOLDS.pricePct,
      volumeMultiple: typeof t?.volumeMultiple === "number" ? t.volumeMultiple : DEFAULT_THRESHOLDS.volumeMultiple,
      lookback: typeof t?.lookback === "number" ? t.lookback : DEFAULT_THRESHOLDS.lookback,
    },
    alertCategories: Array.isArray(raw.alertCategories) ? raw.alertCategories.filter(isCategory) : DEFAULT_SETTINGS.alertCategories,
  };
}

type SettingsContextValue = {
  ready: boolean;
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  reset: () => void;
  done: Record<string, number>;
  markDone: (id: string) => void;
  undoDone: (id: string) => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [done, setDone] = useState<Record<string, number>>({});

  useEffect(() => {
    const now = Date.now();
    const storedDone = read<Record<string, number>>(DONE_KEY) ?? {};
    const fresh = Object.fromEntries(Object.entries(storedDone).filter(([, at]) => typeof at === "number" && now - at < DONE_TTL_MS));
    // Loading persisted state on mount is the one place a post-render update is intended.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(sanitize(read<Partial<Settings>>(SETTINGS_KEY)));
    setDone(fresh);
    setReady(true);
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = sanitize({ ...prev, ...patch });
      write(SETTINGS_KEY, next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    write(SETTINGS_KEY, DEFAULT_SETTINGS);
    setSettings(DEFAULT_SETTINGS);
  }, []);

  const markDone = useCallback((id: string) => {
    setDone((prev) => {
      const next = { ...prev, [id]: Date.now() };
      write(DONE_KEY, next);
      return next;
    });
  }, []);

  const undoDone = useCallback((id: string) => {
    setDone((prev) => {
      const next = { ...prev };
      delete next[id];
      write(DONE_KEY, next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ ready, settings, update, reset, done, markDone, undoDone }), [ready, settings, update, reset, done, markDone, undoDone]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside SettingsProvider");
  return ctx;
}
