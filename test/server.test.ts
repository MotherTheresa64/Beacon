import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.ts";

async function withServer(fn: (url: string) => Promise<void>): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (url: string, path: string, body: unknown) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("the page and the scrape endpoint are served", async () => {
  await withServer(async (url) => {
    const page = await fetch(`${url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /Beacon/);

    const metrics = await fetch(`${url}/metrics`);
    assert.equal(metrics.status, 200);
    assert.match(metrics.headers.get("content-type") ?? "", /text\/plain/);
    const text = await metrics.text();
    assert.match(text, /# TYPE http_requests_total counter/);
    assert.match(text, /# TYPE request_duration_seconds histogram/);
  });
});

test("recording requests shows up in the scrape", async () => {
  await withServer(async (url) => {
    assert.equal((await post(url, "/requests", { route: "/checkout", status: "200" })).status, 204);
    assert.equal((await post(url, "/requests", { route: "/checkout", status: "200" })).status, 204);
    assert.equal((await post(url, "/requests", { route: "/checkout", status: "500" })).status, 204);

    const text = await (await fetch(`${url}/metrics`)).text();
    assert.match(text, /http_requests_total\{route="\/checkout",status="200"\} 2/);
    assert.match(text, /http_requests_total\{route="\/checkout",status="500"\} 1/);
  });
});

test("histogram observations land in the right buckets", async () => {
  await withServer(async (url) => {
    await post(url, "/latency", { route: "/checkout", seconds: 0.03 });
    await post(url, "/latency", { route: "/checkout", seconds: 0.2 });

    const text = await (await fetch(`${url}/metrics`)).text();
    assert.match(text, /request_duration_seconds_bucket\{route="\/checkout",le="0.05"\} 1/);
    assert.match(text, /request_duration_seconds_bucket\{route="\/checkout",le="0.25"\} 2/);
    assert.match(text, /request_duration_seconds_count\{route="\/checkout"\} 2/);
  });
});

test("reset clears the registry and rejects bad input", async () => {
  await withServer(async (url) => {
    await post(url, "/requests", { route: "/x", status: "200" });
    assert.equal((await post(url, "/reset", {})).status, 204);
    const text = await (await fetch(`${url}/metrics`)).text();
    assert.doesNotMatch(text, /http_requests_total\{/);

    assert.equal((await post(url, "/latency", { route: "/x", seconds: -1 })).status, 400);
    assert.equal((await post(url, "/latency", { route: "/x", seconds: "abc" })).status, 400);
  });
});
