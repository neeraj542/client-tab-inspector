import { formatBytes, formatClock, formatMs, hostOf, percentile } from "./format";
import type { Finding, RequestMeta, StorageSnapshot } from "./types";

export type Lens = "developer" | "devops" | "user" | "white" | "gray" | "black";

export const LENSES: { id: Lens; label: string; hint: string }[] = [
  { id: "developer", label: "Developer", hint: "Hosts, calls, headers, and bodies" },
  { id: "devops", label: "DevOps", hint: "Latency, failures, and payload size" },
  { id: "user", label: "User", hint: "What the page just did, in order" },
  { id: "white", label: "Hacker (white)", hint: "What to change on this tab" },
  { id: "gray", label: "Hacker (gray)", hint: "What a report would already include" },
  { id: "black", label: "Hacker (black)", hint: "What is already visible, values redacted" },
];

export type BrowserTab = {
  tabId: number;
  title: string;
  url: string;
  favIconUrl?: string;
  active: boolean;
  attached: boolean;
  focusedWindow?: boolean;
};

export type FlowHost = {
  host: string;
  sameSite: boolean;
  out: number;
  inn: number;
  errors: number;
  bytes: number;
};

export function trafficFlow(requests: RequestMeta[], pageUrl: string | null) {
  let pageHost = "";
  try {
    pageHost = new URL(pageUrl || "").host;
  } catch {
    pageHost = "";
  }
  const map = new Map<string, FlowHost>();
  for (const request of requests) {
    const host = request.url ? hostOf(request.url) : "";
    if (!host) continue;
    const row = map.get(host) ?? {
      host,
      sameSite: Boolean(pageHost) && host === pageHost,
      out: 0,
      inn: 0,
      errors: 0,
      bytes: 0,
    };
    row.out += 1;
    if (request.status != null) row.inn += 1;
    if ((request.status ?? 0) >= 400 || request.error) row.errors += 1;
    row.bytes += request.size ?? 0;
    map.set(host, row);
  }
  const hosts = [...map.values()].sort((a, b) => b.out - a.out);
  return {
    pageHost: pageHost || "this tab",
    sameSite: hosts.filter((host) => host.sameSite),
    eastWest: hosts.filter((host) => !host.sameSite),
    outbound: requests.length,
    inbound: requests.filter((request) => request.status != null).length,
  };
}

export function requestHost(request: RequestMeta) {
  return request.url ? hostOf(request.url) : "";
}

export function FlowBoard({
  flow,
  selectedHost,
  onSelect,
}: {
  flow: ReturnType<typeof trafficFlow>;
  selectedHost: string | null;
  onSelect: (host: string | null) => void;
}) {
  return (
    <section className="flow" aria-label="Traffic direction">
      <div className="flow-counts">
        <button type="button" className={selectedHost ? "chip" : "chip on"} onClick={() => onSelect(null)}>All hosts</button>
        <span>{flow.outbound} requests</span>
        <span>{flow.inbound} responses</span>
        <span>{flow.eastWest.length} other host{flow.eastWest.length === 1 ? "" : "s"}</span>
      </div>
      <div className="flow-grid">
        <HostColumn
          title="Same site"
          empty="No calls to this tab's own host yet."
          hosts={flow.sameSite}
          selectedHost={selectedHost}
          onSelect={onSelect}
        />
        <div className="flow-page">
          <strong>{flow.pageHost}</strong>
          <span>Selected tab</span>
        </div>
        <HostColumn
          title="Other hosts"
          empty="No calls have left this site yet."
          hosts={flow.eastWest}
          selectedHost={selectedHost}
          onSelect={onSelect}
        />
      </div>
    </section>
  );
}

function HostColumn({
  title,
  empty,
  hosts,
  selectedHost,
  onSelect,
}: {
  title: string;
  empty: string;
  hosts: FlowHost[];
  selectedHost: string | null;
  onSelect: (host: string | null) => void;
}) {
  return (
    <div>
      <h2>{title}</h2>
      {hosts.length === 0 ? <p className="caption">{empty}</p> : (
        <ul className="host-list">
          {hosts.map((host) => (
            <li key={host.host}>
              <button
                type="button"
                className={selectedHost === host.host ? "host on" : "host"}
                onClick={() => onSelect(selectedHost === host.host ? null : host.host)}
              >
                <strong>{host.host}</strong>
                <span>{host.out} requests · {host.inn} responses · {formatBytes(host.bytes)} returned{host.errors ? ` · ${host.errors} errors` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function endpointHealth(requests: RequestMeta[]) {
  const groups = new Map<string, RequestMeta[]>();
  for (const request of requests) {
    const key = request.endpoint || "/";
    const list = groups.get(key) ?? [];
    list.push(request);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([endpoint, rows]) => {
    const latencies = rows.map((row) => row.latencyMs).filter((value): value is number => value != null);
    const errors = rows.filter((row) => (row.status ?? 0) >= 400 || row.error).length;
    const bytes = rows.reduce((sum, row) => sum + (row.size ?? 0), 0);
    return {
      endpoint,
      count: rows.length,
      errors,
      errorRate: Math.round((errors / rows.length) * 100),
      p95: percentile(latencies, 0.95),
      bytes,
    };
  }).sort((a, b) => b.bytes - a.bytes);
}

export function DevopsTable({ rows }: { rows: ReturnType<typeof endpointHealth> }) {
  if (!rows.length) return <p className="panel-empty">Endpoint health appears after the first call.</p>;
  return (
    <div className="table-wrap devops">
      <table>
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Calls</th>
            <th>Error rate</th>
            <th>p95</th>
            <th>Bytes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.endpoint}>
              <td className="endpoint">{row.endpoint}</td>
              <td>{row.count}</td>
              <td className={row.errors ? "bad" : "ok"}>{row.errorRate}%</td>
              <td>{formatMs(row.p95)}</td>
              <td>{formatBytes(row.bytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UserFeed({
  requests,
  findings,
  onPick,
}: {
  requests: RequestMeta[];
  findings: Finding[];
  onPick: (id: string) => void;
}) {
  const lines = [...requests].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return (
    <div className="story">
      {findings.slice(0, 3).map((finding) => (
        <p key={finding.id} className="story-alert">{plainFinding(finding)}</p>
      ))}
      {lines.length === 0 ? <p className="panel-empty">Use the tab, and this feed will narrate each call.</p> : (
        <ol>
          {lines.map((request) => (
            <li key={request.requestId}>
              <button type="button" onClick={() => onPick(request.requestId)}>
                <time>{formatClock(request.startedAt)}</time>
                <span>{narrate(request)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function narrate(request: RequestMeta) {
  const target = request.endpoint || "the server";
  const direction = requestHost(request);
  if (request.status == null) return `The page sent ${request.method} ${target} to ${direction}. Still waiting.`;
  if ((request.status ?? 0) >= 400) return `The page sent ${request.method} ${target}. ${direction} answered ${request.status}.`;
  return `The page sent ${request.method} ${target} to ${direction}. The answer came back in ${formatMs(request.latencyMs)}.`;
}

export function SecurityBoard({
  lens,
  findings,
  storage,
}: {
  lens: "white" | "gray" | "black";
  findings: Finding[];
  storage: StorageSnapshot | null;
}) {
  const intro = lens === "white"
    ? "Fixes for the tab you are watching. Each item says what to change."
    : lens === "gray"
      ? "What a report would include: where it sits, who can already see it, and the change. No exploit steps."
      : "What is already visible on this tab. Values stay redacted. This lens does not explain how to abuse them.";
  return (
    <div className="security">
      <p className="caption">{intro}</p>
      {findings.length === 0 ? <p className="panel-empty">Nothing in this lens yet.</p> : (
        <ol className="findings">
          {findings.map((finding) => (
            <li key={finding.id}>
              <span className={`sev ${finding.severity}`}>{finding.severity}</span>
              <h3>{finding.title}</h3>
              <p>{lensCopy(lens, finding)}</p>
            </li>
          ))}
        </ol>
      )}
      {storage ? <StorageGlance storage={storage} /> : null}
    </div>
  );
}

function lensCopy(lens: "white" | "gray" | "black", finding: Finding) {
  const exposed = impact(finding);
  if (lens === "white") return finding.detail;
  if (lens === "gray") return `${finding.subject || "This tab"} — ${exposed} The change is in the white-hat wording: ${finding.detail}`;
  return `Already on this tab. ${exposed} The raw value is redacted.`;
}

function impact(finding: Finding) {
  switch (finding.rule) {
    case "jwt-storage":
      return "Any script on this origin can read the session.";
    case "secret-query":
      return "The parameter is in the address, so it can land in history and logs.";
    case "cookie-httponly":
      return "Page script can read a session cookie.";
    case "cookie-flags":
      return "A cookie on HTTPS is missing a browser protection.";
    case "duplicate-get":
      return "The page is sending the same call twice.";
    case "large-body":
      return "The response is large enough to slow the page.";
    default:
      return finding.detail;
  }
}

function plainFinding(finding: Finding) {
  return impact(finding);
}

function StorageGlance({ storage }: { storage: StorageSnapshot }) {
  const readable = storage.cookies.filter((cookie) => cookie.jsVisible && cookie.sessionLike);
  return (
    <p className="caption">
      Storage on {storage.origin || "this origin"}: {storage.localStorage.length} local keys, {readable.length} session-like cookies the page can read.
    </p>
  );
}
