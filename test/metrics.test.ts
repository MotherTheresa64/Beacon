import test from "node:test";
import assert from "node:assert/strict";
import { Counter, Gauge, Histogram, Registry, ValidationError } from "../src/metrics.ts";

test("counters accumulate and separate series by label", () => {
  const registry = new Registry();
  const hits = registry.counter("http_requests_total", "Total HTTP requests", ["route", "method"]);
  hits.inc({ route: "/", method: "GET" });
  hits.inc({ route: "/", method: "GET" }, 4);
  hits.inc({ route: "/health", method: "GET" });

  assert.equal(hits.get({ route: "/", method: "GET" }), 5);
  assert.equal(hits.get({ route: "/health", method: "GET" }), 1);
  assert.equal(hits.get({ route: "/missing", method: "GET" }), 0, "unseen series read as zero");
  assert.throws(() => hits.inc({ route: "/" }, -1), ValidationError, "counters cannot decrease");
});

test("gauges move in both directions", () => {
  const registry = new Registry();
  const queue = registry.gauge("queue_depth", "Jobs waiting");
  queue.set(10);
  queue.inc();
  queue.inc(undefined, 4);
  queue.dec();
  assert.equal(queue.get(), 14);
  queue.set(-3);
  assert.equal(queue.get(), -3, "a gauge may legitimately be negative");
});

test("histogram buckets are cumulative and include +Inf", () => {
  const histogram = new Histogram("request_seconds", "Latency", [], [0.1, 0.5, 1]);
  histogram.observe(0.05);
  histogram.observe(0.2);
  histogram.observe(0.2);
  histogram.observe(2);

  const lines = histogram.lines();
  const bucket = (le: string): number => {
    const line = lines.find((l) => l.startsWith("request_seconds_bucket") && l.includes(`le="${le}"`));
    assert.ok(line, `missing bucket le=${le}`);
    return Number(line.split(" ").pop());
  };

  assert.equal(bucket("0.1"), 1);
  assert.equal(bucket("0.5"), 3);
  assert.equal(bucket("1"), 3);
  assert.equal(bucket("+Inf"), 4, "everything lands in +Inf");
  assert.match(lines.find((l) => l.startsWith("request_seconds_count"))!, / 4$/);
  assert.match(lines.find((l) => l.startsWith("request_seconds_sum"))!, / 2\.45$/);
});

test("histogram observations above the last bucket are still counted", () => {
  const histogram = new Histogram("h", "h", [], [1]);
  histogram.observe(5);
  const { count, sum } = histogram.get();
  assert.equal(count, 1);
  assert.equal(sum, 5);
  assert.match(histogram.lines().find((l) => l.includes('le="+Inf"'))!, / 1$/);
});

test("exposition includes HELP and TYPE for each metric", () => {
  const registry = new Registry();
  registry.counter("a_total", "Counter help");
  registry.gauge("b_gauge", "Gauge help");
  registry.histogram("c_seconds", "Histogram help");

  const text = registry.render();
  assert.match(text, /^# HELP a_total Counter help$/m);
  assert.match(text, /^# TYPE a_total counter$/m);
  assert.match(text, /^# TYPE b_gauge gauge$/m);
  assert.match(text, /^# TYPE c_seconds histogram$/m);
  assert.ok(text.endsWith("\n"));
});

test("label values are escaped for the exposition format", () => {
  const registry = new Registry();
  const metric = registry.counter("escaped_total", "h", ["path"]);
  metric.inc({ path: '/a"b\\c\nd' });
  const line = registry.render().split("\n").find((l) => l.startsWith("escaped_total{"))!;
  assert.equal(line, 'escaped_total{path="/a\\"b\\\\c\\nd"} 1');
});

test("series are rendered in a stable order", () => {
  const registry = new Registry();
  const metric = registry.counter("stable_total", "h", ["k"]);
  metric.inc({ k: "b" });
  metric.inc({ k: "a" });
  metric.inc({ k: "c" });
  const keys = registry
    .render()
    .split("\n")
    .filter((l) => l.startsWith("stable_total{"))
    .map((l) => /k="([^"]*)"/.exec(l)![1]);
  assert.deepEqual(keys, ["a", "b", "c"]);
});

test("timers record seconds into a registered histogram", () => {
  const registry = new Registry();
  registry.histogram("latency_seconds", "Latency", ["route"], [0.1, 1]);
  const stop = registry.timer("latency_seconds", { route: "/api" });
  stop(250);
  const text = registry.render();
  assert.match(text, /latency_seconds_bucket\{route="\/api",le="0.1"\} 0/);
  assert.match(text, /latency_seconds_bucket\{route="\/api",le="1"\} 1/);
  assert.match(text, /latency_seconds_sum\{route="\/api"\} 0\.25/);
  assert.throws(() => registry.timer("nope"), ValidationError);
});

test("names, label names and duplicate registration are validated", () => {
  const registry = new Registry();
  assert.throws(() => registry.counter("bad name", "h"), ValidationError);
  assert.throws(() => registry.counter("ok_total", "h", ["bad-name"]), ValidationError);
  assert.throws(() => registry.counter("ok_total", "h", ["a", "a"]), ValidationError);
  assert.throws(() => new Histogram("h", "h", [], []), ValidationError);
  assert.throws(() => new Histogram("h2", "h", [], [1, 1]), ValidationError);

  registry.counter("dup_total", "h");
  assert.throws(() => registry.counter("dup_total", "h"), ValidationError);
  assert.equal(registry.size, 1);
});

test("a non-finite observation is refused", () => {
  const counter = new Counter("c_total", "h");
  assert.throws(() => counter.inc({}, Number.NaN), ValidationError);
  const gauge = new Gauge("g", "h");
  assert.throws(() => gauge.set(Infinity), ValidationError);
  const histogram = new Histogram("hh", "h");
  assert.throws(() => histogram.observe(Number.NaN), ValidationError);
});
