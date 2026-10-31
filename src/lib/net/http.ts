import { config } from "@/lib/config";

/**
 * Polite HTTP for public sources: honest User-Agent, timeouts, bounded retries with
 * backoff, a per-host concurrency cap, and a minimum gap between requests to one host.
 */

export class SourceError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

type HostPolicy = { concurrency: number; minGapMs: number };

const HOST_POLICIES: Record<string, HostPolicy> = {
  "www.screener.in": { concurrency: 2, minGapMs: 400 },
  "nsearchives.nseindia.com": { concurrency: 4, minGapMs: 100 },
  "query1.finance.yahoo.com": { concurrency: 5, minGapMs: 50 },
  "query2.finance.yahoo.com": { concurrency: 5, minGapMs: 50 },
  "www.bseindia.com": { concurrency: 2, minGapMs: 300 },
  "www.nseindia.com": { concurrency: 2, minGapMs: 250 },
};
const DEFAULT_POLICY: HostPolicy = { concurrency: 3, minGapMs: 200 };

/** Only these hosts may be fetched on behalf of a client-supplied URL (SSRF guard). */
export const DOCUMENT_HOSTS = new Set([
  "nsearchives.nseindia.com",
  "archives.nseindia.com",
  "www.bseindia.com",
]);

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[.*\])$/i;

/**
 * Company investor-relations sites host many transcripts. Those links come from screener's
 * page (not from our users), but are still third-party input: only public https hosts on the
 * default port are fetched.
 */
export function isPublicHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && (url.port === "" || url.port === "443") && !PRIVATE_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

export function assertDocumentUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceError("Not a valid URL", "input");
  }
  if (url.protocol !== "https:" || !DOCUMENT_HOSTS.has(url.hostname)) {
    throw new SourceError(`Documents can only be fetched from exchange hosts (got ${url.hostname})`, "input");
  }
  return url;
}

class HostGate {
  private active = 0;
  private queue: (() => void)[] = [];
  private lastStart = 0;
  constructor(private policy: HostPolicy) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.policy.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    const wait = this.lastStart + this.policy.minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastStart = Date.now();
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const gates = new Map<string, HostGate>();
function gateFor(host: string) {
  let gate = gates.get(host);
  if (!gate) {
    gate = new HostGate(HOST_POLICIES[host] ?? DEFAULT_POLICY);
    gates.set(host, gate);
  }
  return gate;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export type FetchOptions = {
  source: string;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  maxBytes?: number;
  /** Reject the response if redirects end on a host outside this set ("public" = any public https host). */
  allowHosts?: ReadonlySet<string> | "public";
};

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * A host that sent no response within the timeout is not asked again for a minute: further
 * requests to it fail at once, so callers fall back to their labelled snapshot instead of each
 * waiting out its own timeout (twenty symbols against a hung host took minutes). Keyed by
 * host:port. A slow body on a host that did answer is not a dead host and does not count.
 */
export const UNRESPONSIVE_MS = 60_000;
const unresponsiveUntil = new Map<string, number>();

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

function failFast(hostKey: string, source: string, url: string): SourceError | null {
  const until = unresponsiveUntil.get(hostKey);
  if (until == null || Date.now() >= until) return null;
  return new SourceError(`${source} unreachable (${hostKey} did not respond to a request in the last minute; not asked again yet)`, source, undefined, url);
}

async function request(url: string, opts: FetchOptions): Promise<Response> {
  const { source, timeoutMs = 15_000, retries = 2, headers = {} } = opts;
  const { hostname: host, host: hostKey } = new URL(url);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1) + Math.random() * 250);
    const blocked = failFast(hostKey, source, url);
    if (blocked) throw blocked;
    try {
      const res = await gateFor(host).run(() => {
        // Checked again here: requests queued behind the one that timed out must not each wait too.
        const queued = failFast(hostKey, source, url);
        if (queued) throw queued;
        return fetch(url, {
          headers: { "User-Agent": config.userAgent, "Accept-Encoding": "gzip, deflate", ...headers },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "follow",
        }).catch((err: unknown) => {
          // No response at all within the timeout: a retry would only wait as long again.
          if (!isTimeout(err)) throw err;
          unresponsiveUntil.set(hostKey, Date.now() + UNRESPONSIVE_MS);
          throw new SourceError(`${source} unreachable (no response within ${timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`})`, source, undefined, url);
        });
      });
      if (opts.allowHosts && res.url) {
        const ok = opts.allowHosts === "public" ? isPublicHttpsUrl(res.url) : opts.allowHosts.has(new URL(res.url).hostname);
        if (!ok) throw new SourceError(`${source}: redirected to a disallowed host`, source, 403, url);
      }
      if (res.ok) return res;
      if (res.status === 404) throw new SourceError(`${source}: not found`, source, 404, url);
      if (!RETRYABLE.has(res.status)) {
        throw new SourceError(`${source} responded ${res.status}`, source, res.status, url);
      }
      lastError = new SourceError(`${source} responded ${res.status}`, source, res.status, url);
    } catch (err) {
      if (err instanceof SourceError && !RETRYABLE.has(err.status ?? 0)) throw err;
      lastError = err;
    }
  }
  if (lastError instanceof SourceError) throw lastError;
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new SourceError(`${source} unreachable (${reason})`, source, undefined, url);
}

export async function fetchText(url: string, opts: FetchOptions): Promise<string> {
  const res = await request(url, opts);
  return res.text();
}

/** A JSON API that answers with an HTML page has usually refused the request; say so plainly. */
export async function fetchJson<T>(url: string, opts: FetchOptions): Promise<T> {
  const res = await request(url, { ...opts, headers: { Accept: "application/json", ...opts.headers } });
  const type = res.headers.get("content-type") ?? "";
  if (!/json/i.test(type)) {
    await res.body?.cancel();
    throw new SourceError(`${opts.source} answered with ${type.split(";")[0] || "an unknown content type"} instead of JSON (likely an access block)`, opts.source, res.status, url);
  }
  return (await res.json()) as T;
}

/** The first `bytes` of a document (Range request; the stream is cut off if the host ignores it). */
export async function fetchPrefix(url: string, opts: FetchOptions, bytes = 1024): Promise<{ status: number; contentType: string; prefix: Uint8Array }> {
  const res = await request(url, { ...opts, headers: { Range: `bytes=0-${bytes - 1}`, ...opts.headers } });
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0];
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader && total < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader?.cancel();
  const prefix = new Uint8Array(Math.min(total, bytes));
  let offset = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, prefix.length - offset);
    prefix.set(c.subarray(0, take), offset);
    offset += take;
    if (offset >= prefix.length) break;
  }
  return { status: res.status, contentType, prefix };
}

/** Binary download with a hard size cap, so a 300-page annual report cannot exhaust memory. */
export async function fetchBytes(url: string, opts: FetchOptions): Promise<Uint8Array> {
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;
  const res = await request(url, opts);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    throw new SourceError(`${opts.source}: document too large (${Math.round(declared / 1e6)} MB)`, opts.source, undefined, url);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new SourceError(`${opts.source}: document exceeds ${Math.round(maxBytes / 1e6)} MB`, opts.source, undefined, url);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
