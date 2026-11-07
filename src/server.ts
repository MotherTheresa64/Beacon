import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Registry, type Counter, type Histogram } from "./metrics.ts";

interface State {
  registry: Registry;
  requests: Counter;
  latency: Histogram;
}

function buildRegistry(): State {
  const registry = new Registry();
  const requests = registry.counter("http_requests_total", "Requests served", ["route", "status"]);
  const latency = registry.histogram(
    "request_duration_seconds",
    "Request latency in seconds",
    ["route"],
    [0.05, 0.1, 0.25, 0.5, 1],
  );
  return { registry, requests, latency };
}

let cachedPage: string | null = null;

function indexHtml(): string {
  if (cachedPage === null) {
    cachedPage = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  }
  return cachedPage;
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(err instanceof Error && err.message.startsWith("request body") ? err.message : "request body is not valid JSON");
  }
}

export function createApp(): Server {
  let state = buildRegistry();

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return send(res, 200, indexHtml(), "text/html; charset=utf-8");
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { status: "ok" });
      }

      if (req.method === "GET" && url.pathname === "/metrics") {
        return send(res, 200, state.registry.render(), "text/plain; charset=utf-8");
      }

      if (req.method === "POST" && url.pathname === "/requests") {
        const body = await readJson(req);
        const route = String(body.route ?? "/");
        const status = String(body.status ?? "200");
        state.requests.inc({ route, status });
        return send(res, 204, "");
      }

      if (req.method === "POST" && url.pathname === "/latency") {
        const body = await readJson(req);
        const seconds = Number(body.seconds);
        if (!Number.isFinite(seconds) || seconds < 0) {
          return send(res, 400, { error: "invalid", message: "seconds must be a non-negative number" });
        }
        state.latency.observe(seconds, { route: String(body.route ?? "/") });
        return send(res, 204, "");
      }

      if (req.method === "POST" && url.pathname === "/reset") {
        state = buildRegistry();
        return send(res, 204, "");
      }

      return send(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("request body")) {
        return send(res, 400, { error: "invalid", message: err.message });
      }
      return send(res, 500, { error: "internal", message: "unexpected failure" });
    }
  });
}

// pathToFileURL matters on Windows: argv[1] is a drive path there, which never
// equals the file:/// URL form.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const port = Number(process.env.PORT ?? 4101);
  createApp().listen(port, () => {
    console.log(`beacon listening on http://localhost:${port}`);
  });
}
