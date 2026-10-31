import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { fetchText } from "@/lib/net/http";

/**
 * The polite HTTP layer against local servers: one that accepts connections and never answers
 * (a hung provider), one that fails twice and then answers, and one that answers at once.
 */

const servers: { close: () => void }[] = [];
afterAll(() => servers.forEach((s) => s.close()));

function listen(server: net.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

const blackhole = () => {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => sockets.push(s));
  servers.push({ close: () => sockets.forEach((s) => s.destroy()) });
  return listen(server);
};

describe("timeouts and a hung provider", () => {
  it("gives up on a host that never answers after one timeout, without retrying", async () => {
    const port = await blackhole();
    const t0 = Date.now();
    await expect(fetchText(`http://127.0.0.1:${port}/feed`, { source: "Test feed", timeoutMs: 300, retries: 2 })).rejects.toThrow("Test feed unreachable (no response within 300 ms)");
    // Three attempts with backoff would take well over two seconds.
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("fails the next request to that host at once, so callers fall back instead of waiting again", async () => {
    const port = await blackhole();
    await expect(fetchText(`http://127.0.0.1:${port}/a`, { source: "Test feed", timeoutMs: 300 })).rejects.toThrow(/no response within/);
    const t0 = Date.now();
    await expect(fetchText(`http://127.0.0.1:${port}/b`, { source: "Test feed", timeoutMs: 300 })).rejects.toThrow(/did not respond to a request in the last minute/);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it("does not hold a hung host against a different one", async () => {
    await blackhole();
    const port = await listen(http.createServer((_req, res) => res.end("ok")));
    await expect(fetchText(`http://127.0.0.1:${port}/`, { source: "Healthy", timeoutMs: 1000 })).resolves.toBe("ok");
  });

  it("still retries a server error and succeeds when the host recovers", async () => {
    let hits = 0;
    const port = await listen(
      http.createServer((_req, res) => {
        hits++;
        res.statusCode = hits < 3 ? 503 : 200;
        res.end(hits < 3 ? "busy" : "fine");
      }),
    );
    await expect(fetchText(`http://127.0.0.1:${port}/`, { source: "Flaky", timeoutMs: 1000, retries: 2 })).resolves.toBe("fine");
    expect(hits).toBe(3);
  });
});
