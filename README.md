# Beacon

A metrics registry: counters, gauges and histograms, rendered in the Prometheus text
exposition format so a `/metrics` endpoint is one function call away.

Zero dependencies.

## Run it

```bash
node --test
```

```ts
import { Registry } from "./src/metrics.ts";

const registry = new Registry();
const requests = registry.counter("http_requests_total", "Total HTTP requests", ["route", "status"]);
registry.histogram("request_seconds", "Request latency", ["route"]);
const stop = registry.timer("request_seconds", { route: "/api" });

requests.inc({ route: "/api", status: "200" });
stop(42);

console.log(registry.render());  // Prometheus text format
```

## Why the three metric types are not interchangeable

**A counter only goes up.** It answers "how many", and any decrease means its data is wrong,
so `inc` refuses negative amounts. Rate calculations (`rate(...)` in PromQL) depend on
monotonicity, which is why this is enforced in code rather than documented as a convention.

**A gauge goes both ways.** Queue depth, connected clients, temperature — anything where the
current value matters and it can fall. Gauges may legitimately be negative.

**A histogram is buckets, not averages.** Averages hide the shape of a distribution: a service
answering 99 requests in 5ms and one in 3 seconds averages 35ms, which is a useless number.
Histogram buckets make the tail visible, and the tail is what wakes people up.

## The part that is easy to get wrong

Prometheus expects **cumulative** buckets: `le="0.5"` means "500ms or less", so each bucket
must include every observation from the smaller ones. Beacon stores per-bucket counts
(non-cumulative) and accumulates at render time — that keeps `observe()` O(1) and makes the
cumulative view a rendering concern rather than a data-mutation one.

`+Inf` is always emitted and always equals `_count`. If it does not, the exposition is
malformed and scrape-time queries return wrong rates.

Label values are escaped (`\`, `"`, newline), because an unescaped quote in a label turns the
whole exposition into a parse error for the scraper — one bad URL path can blind a metric.

## Design decisions

**Series are keyed by declared labels only.** `metric.inc({ path: "/a" })` on a metric declared
with `["route"]` records an empty `route`, rather than inventing a series. That avoids
high-cardinality explosions from typos.

**Rendering is deterministic.** Samples sort by their rendered label set, so a diff between two
scrapes shows real changes instead of map iteration order.

**Duplicate metric names throw.** Two modules registering `http_requests_total` with different
meanings produces silently merged data, which is worse than a crash at startup.

**Buckets must be strictly increasing.** Overlapping bounds make cumulative counts
nonsensical, and the error surfaces at construction rather than in a dashboard.

## Tests

Counter accumulation and per-label separation, gauge movement and negatives, cumulative
bucket correctness with `+Inf` and `_sum`/`_count`, observations beyond the last bucket,
`HELP`/`TYPE` lines, label escaping, deterministic ordering, the timer helper, and validation
of metric names, label names, buckets and duplicate registration.
