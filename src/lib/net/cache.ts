import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";

/**
 * Where a value came from. The UI shows this verbatim, so cached or snapshot data is
 * never presented as live.
 */
export type Provenance = "live" | "cache" | "stale" | "snapshot";

export type Cached<T> = {
  value: T;
  /** When the underlying source was actually fetched (ISO). */
  fetchedAt: string;
  provenance: Provenance;
  /** Set when a live fetch failed and we fell back. */
  error?: string;
};

type Entry<T> = { key: string; fetchedAt: number; value: T };

const memory = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<Cached<unknown>>>();

function fileFor(namespace: string, key: string) {
  const digest = createHash("sha1").update(key).digest("hex");
  return path.join(config.cacheDir, namespace, `${digest}.json`);
}

async function readDisk<T>(namespace: string, key: string): Promise<Entry<T> | null> {
  try {
    const raw = await fs.readFile(fileFor(namespace, key), "utf8");
    const entry = JSON.parse(raw) as Entry<T>;
    return entry.key === key ? entry : null;
  } catch {
    return null;
  }
}

async function writeDisk<T>(namespace: string, entry: Entry<T>) {
  const file = fileFor(namespace, entry.key);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(entry));
  } catch {
    // Read-only or full disk: the in-memory copy still serves this instance.
  }
}

export type CacheOptions<T> = {
  namespace: string;
  /** Freshness window. Use Infinity for immutable documents keyed by URL. */
  ttlMs: number;
  /** Last-resort value (e.g. committed snapshot) when there is no live or cached copy. */
  fallback?: () => Promise<{ value: T; asOf: string } | null>;
};

export async function cached<T>(key: string, opts: CacheOptions<T>, loader: () => Promise<T>): Promise<Cached<T>> {
  const memKey = `${opts.namespace}:${key}`;
  const now = Date.now();
  const isFresh = (e: Entry<unknown>) => now - e.fetchedAt < opts.ttlMs;

  const mem = memory.get(memKey) as Entry<T> | undefined;
  if (mem && isFresh(mem)) return { value: mem.value, fetchedAt: iso(mem.fetchedAt), provenance: "cache" };

  const pending = inflight.get(memKey);
  if (pending) return pending as Promise<Cached<T>>;

  const work = (async (): Promise<Cached<T>> => {
    const disk = mem ?? (await readDisk<T>(opts.namespace, key));
    if (disk && isFresh(disk)) {
      memory.set(memKey, disk);
      return { value: disk.value, fetchedAt: iso(disk.fetchedAt), provenance: "cache" };
    }
    try {
      const value = await loader();
      const entry: Entry<T> = { key, fetchedAt: Date.now(), value };
      memory.set(memKey, entry);
      await writeDisk(opts.namespace, entry);
      return { value, fetchedAt: iso(entry.fetchedAt), provenance: "live" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (disk) return { value: disk.value, fetchedAt: iso(disk.fetchedAt), provenance: "stale", error: message };
      const fb = opts.fallback ? await opts.fallback() : null;
      if (fb) return { value: fb.value, fetchedAt: fb.asOf, provenance: "snapshot", error: message };
      throw err;
    }
  })();

  inflight.set(memKey, work);
  try {
    return await work;
  } finally {
    inflight.delete(memKey);
  }
}

/** Returns a fresh cached value without loading anything; null when absent or expired. */
export async function peek<T>(namespace: string, key: string, ttlMs: number): Promise<Cached<T> | null> {
  const memKey = `${namespace}:${key}`;
  const entry = (memory.get(memKey) as Entry<T> | undefined) ?? (await readDisk<T>(namespace, key));
  if (!entry || Date.now() - entry.fetchedAt >= ttlMs) return null;
  memory.set(memKey, entry);
  return { value: entry.value, fetchedAt: iso(entry.fetchedAt), provenance: "cache" };
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
