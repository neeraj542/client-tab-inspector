import type { RequestMeta } from "./types";

export function formatBytes(size: number | null | undefined) {
  if (size == null) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

export function formatMs(value: number | null | undefined) {
  if (value == null) return "—";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export function formatClock(value: number | null | undefined) {
  if (value == null) return "—";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function hostOf(url: string | null | undefined) {
  if (!url) return "Attached tab";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function statusClass(status: number | null | undefined) {
  if (status == null || status === 0) return "muted";
  if (status < 300) return "ok";
  if (status < 400) return "info";
  if (status < 500) return "warn";
  return "bad";
}

export function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

export function summarize(requests: RequestMeta[]) {
  const latencies = requests.map((request) => request.latencyMs).filter((value): value is number => value != null);
  const errors = requests.filter((request) => (request.status ?? 0) >= 400 || request.error).length;
  return {
    count: requests.length,
    errors,
    errorRate: requests.length ? Math.round((errors / requests.length) * 100) : 0,
    p95: percentile(latencies, 0.95),
  };
}

export type BucketSet = {
  unit: string;
  labels: string[];
  p50: number[];
  p95: number[];
  errors: number[];
};

export function buckets(requests: RequestMeta[]): BucketSet | null {
  const timed = requests.filter((request) => request.startedAt != null);
  if (!timed.length) return null;
  const origin = Math.min(...timed.map((request) => request.startedAt as number));
  const end = Math.max(...timed.map((request) => request.startedAt as number));
  const span = Math.max(1, end - origin);
  const bucketMs = span < 120_000 ? 10_000 : 60_000;
  const count = Math.min(24, Math.floor(span / bucketMs) + 1);
  const width = span / count;
  const rows = Array.from({ length: count }, (_, index) => ({
    label: String(Math.round((index * width) / (bucketMs === 10_000 ? 1000 : 60_000))),
    latencies: [] as number[],
    errors: 0,
  }));
  for (const request of timed) {
    const index = Math.min(count - 1, Math.floor(((request.startedAt as number) - origin) / width));
    const row = rows[index];
    if (request.latencyMs != null) row.latencies.push(request.latencyMs);
    if ((request.status ?? 0) >= 400 || request.error) row.errors += 1;
  }
  return {
    unit: bucketMs === 10_000 ? "seconds from first request" : "minutes from first request",
    labels: rows.map((row) => row.label),
    p50: rows.map((row) => percentile(row.latencies, 0.5)),
    p95: rows.map((row) => percentile(row.latencies, 0.95)),
    errors: rows.map((row) => row.errors),
  };
}

export function bytesByEndpoint(requests: RequestMeta[]) {
  const totals = new Map<string, number>();
  for (const request of requests) {
    const key = request.endpoint || "/";
    totals.set(key, (totals.get(key) ?? 0) + (request.size ?? 0));
  }
  return [...totals.entries()]
    .map(([endpoint, bytes]) => ({ endpoint, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 6);
}
