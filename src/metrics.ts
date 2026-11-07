export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export type Labels = Record<string, string>;

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  // Prometheus accepts exponents, but fixed notation is easier to read in a diff.
  return String(Number(value.toFixed(6)));
}

function seriesKey(labelNames: string[], labels: Labels): string {
  return labelNames.map((name) => `${name}\u0000${labels[name] ?? ""}`).join("\u0001");
}

function labelSuffix(labelNames: string[], labels: Labels): string {
  if (labelNames.length === 0) return "";
  const parts = labelNames.map((name) => `${name}="${escapeLabel(labels[name] ?? "")}"`);
  return `{${parts.join(",")}}`;
}

function assertMetricName(name: string): void {
  if (!METRIC_NAME.test(name)) {
    throw new ValidationError(`invalid metric name '${name}': use [a-zA-Z_:][a-zA-Z0-9_:]*`);
  }
}

function assertLabelNames(names: string[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!LABEL_NAME.test(name)) throw new ValidationError(`invalid label name '${name}'`);
    if (seen.has(name)) throw new ValidationError(`duplicate label name '${name}'`);
    seen.add(name);
  }
}

interface Metric {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  lines(): string[];
}

export class Counter implements Metric {
  readonly name: string;
  readonly help: string;
  readonly type = "counter" as const;
  readonly labelNames: string[];
  private series = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string, labelNames: string[] = []) {
    assertMetricName(name);
    assertLabelNames(labelNames);
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
  }

  inc(labels: Labels = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new ValidationError("a counter can only increase");
    }
    const key = seriesKey(this.labelNames, labels);
    const current = this.series.get(key);
    if (current) current.value += amount;
    else this.series.set(key, { labels: { ...labels }, value: amount });
  }

  get(labels: Labels = {}): number {
    return this.series.get(seriesKey(this.labelNames, labels))?.value ?? 0;
  }

  lines(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.sorted()) {
      out.push(`${this.name}${labelSuffix(this.labelNames, labels)} ${formatValue(value)}`);
    }
    return out;
  }

  private sorted() {
    return [...this.series.values()].sort((a, b) =>
      labelSuffix(this.labelNames, a.labels).localeCompare(labelSuffix(this.labelNames, b.labels)),
    );
  }
}

export class Gauge implements Metric {
  readonly name: string;
  readonly help: string;
  readonly type = "gauge" as const;
  readonly labelNames: string[];
  private series = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string, labelNames: string[] = []) {
    assertMetricName(name);
    assertLabelNames(labelNames);
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
  }

  set(value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) throw new ValidationError("a gauge needs a finite number");
    this.series.set(seriesKey(this.labelNames, labels), { labels: { ...labels }, value });
  }

  inc(labels: Labels = {}, amount = 1): void {
    this.set(this.get(labels) + amount, labels);
  }

  dec(labels: Labels = {}, amount = 1): void {
    this.set(this.get(labels) - amount, labels);
  }

  get(labels: Labels = {}): number {
    return this.series.get(seriesKey(this.labelNames, labels))?.value ?? 0;
  }

  lines(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of [...this.series.values()].sort((a, b) =>
      labelSuffix(this.labelNames, a.labels).localeCompare(labelSuffix(this.labelNames, b.labels)),
    )) {
      out.push(`${this.name}${labelSuffix(this.labelNames, labels)} ${formatValue(value)}`);
    }
    return out;
  }
}

export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram implements Metric {
  readonly name: string;
  readonly help: string;
  readonly type = "histogram" as const;
  readonly labelNames: string[];
  readonly buckets: number[];
  private series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();

  constructor(name: string, help: string, labelNames: string[] = [], buckets: number[] = DEFAULT_BUCKETS) {
    assertMetricName(name);
    assertLabelNames(labelNames);
    const ascending = [...buckets].sort((a, b) => a - b);
    if (ascending.length === 0 || ascending.some((b, i) => i > 0 && b === ascending[i - 1])) {
      throw new ValidationError("buckets must be a non-empty, strictly increasing list");
    }
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.buckets = ascending;
  }

  observe(value: number, labels: Labels = {}): void {
    if (!Number.isFinite(value)) throw new ValidationError("observed value must be finite");
    const key = seriesKey(this.labelNames, labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = {
        labels: { ...labels },
        counts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, entry);
    }
    // Counts are stored per bucket (non-cumulative) and accumulated at render time, so a
    // bucket that is added later cannot corrupt the history of existing observations.
    let index = this.buckets.findIndex((bound) => value <= bound);
    if (index === -1) index = this.buckets.length - 1;
    if (value > this.buckets[this.buckets.length - 1]) index = this.buckets.length;
    if (index < this.buckets.length) entry.counts[index] += 1;
    entry.sum += value;
    entry.count += 1;
  }

  get(labels: Labels = {}): { count: number; sum: number } {
    const entry = this.series.get(seriesKey(this.labelNames, labels));
    return entry ? { count: entry.count, sum: entry.sum } : { count: 0, sum: 0 };
  }

  lines(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    const entries = [...this.series.values()].sort((a, b) =>
      labelSuffix(this.labelNames, a.labels).localeCompare(labelSuffix(this.labelNames, b.labels)),
    );

    for (const entry of entries) {
      let cumulative = 0;
      const bounds = [...this.buckets, Number.POSITIVE_INFINITY];
      for (let i = 0; i < bounds.length; i++) {
        if (i < entry.counts.length) cumulative += entry.counts[i];
        const bound = bounds[i];
        const labelPairs = [
          ...this.labelNames.map((name) => `${name}="${escapeLabel(entry.labels[name] ?? "")}"`),
          `le="${bound === Number.POSITIVE_INFINITY ? "+Inf" : formatValue(bound)}"`,
        ];
        // +Inf must equal _count exactly: observations above the last finite bound live only here.
        const rendered = bound === Number.POSITIVE_INFINITY ? entry.count : cumulative;
        out.push(`${this.name}_bucket{${labelPairs.join(",")}} ${rendered}`);
      }
      out.push(`${this.name}_sum${labelSuffix(this.labelNames, entry.labels)} ${formatValue(entry.sum)}`);
      out.push(`${this.name}_count${labelSuffix(this.labelNames, entry.labels)} ${entry.count}`);
    }
    return out;
  }
}

export class Registry {
  private metrics = new Map<string, Metric>();

  private register(metric: Metric): void {
    if (this.metrics.has(metric.name)) {
      throw new ValidationError(`metric already registered: ${metric.name}`);
    }
    this.metrics.set(metric.name, metric);
  }

  counter(name: string, help: string, labelNames: string[] = []): Counter {
    const metric = new Counter(name, help, labelNames);
    this.register(metric);
    return metric;
  }

  gauge(name: string, help: string, labelNames: string[] = []): Gauge {
    const metric = new Gauge(name, help, labelNames);
    this.register(metric);
    return metric;
  }

  histogram(
    name: string,
    help: string,
    labelNames: string[] = [],
    buckets: number[] = DEFAULT_BUCKETS,
  ): Histogram {
    const metric = new Histogram(name, help, labelNames, buckets);
    this.register(metric);
    return metric;
  }

  /** Records elapsed milliseconds into a histogram expressed in seconds. */
  timer(name: string, labels: Labels = {}): (elapsedMs: number) => void {
    const histogram = this.metrics.get(name);
    if (!histogram || histogram.type !== "histogram") {
      throw new ValidationError(`no histogram registered as ${name}`);
    }
    return (elapsedMs: number) => (histogram as Histogram).observe(elapsedMs / 1000, labels);
  }

  render(): string {
    const blocks: string[] = [];
    for (const metric of this.metrics.values()) blocks.push(metric.lines().join("\n"));
    return `${blocks.join("\n")}\n`;
  }

  get size(): number {
    return this.metrics.size;
  }
}
