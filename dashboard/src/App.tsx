import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BytesChart, ErrorChart, LatencyChart } from "./charts";
import { buckets, bytesByEndpoint, formatBytes, formatClock, formatMs, hostOf, statusClass, summarize } from "./format";
import {
  BrowserTab,
  DevopsTable,
  LENSES,
  Lens,
  SecurityBoard,
  UserFeed,
  endpointHealth,
  requestHost,
  trafficFlow,
} from "./lenses";
import {
  ChromeMemory,
  CompareBoard,
  Dossier,
  HistoryBoard,
  ProfileMenu,
  TestBoard,
} from "./advanced";
import type { Finding, RequestDetail, RequestMeta, Session, StorageSnapshot } from "./types";

type Filter = "all" | "errors" | "slow";
type Panel = "findings" | "storage";
type Screen = "brief" | "calls" | "changes" | "record";

let bridgeSeq = 0;

function askExtension(type: "tabs" | "inspect" | "page-memory", extra: { tabId?: number; url?: string } = {}) {
  return new Promise<Record<string, unknown> | null>((resolve) => {
    const id = ++bridgeSeq;
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, 700);
    function onMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== location.origin) return;
      const data = event.data as { source?: string; id?: number; response?: Record<string, unknown>; error?: string };
      if (!data || data.source !== "cti-ext" || data.id !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (data.error) resolve({ error: data.error });
      else resolve(data.response ?? null);
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "cti-page", id, type, ...extra }, location.origin);
  });
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [requests, setRequests] = useState<RequestMeta[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [storage, setStorage] = useState<StorageSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [panel, setPanel] = useState<Panel>("findings");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState("");
  const [requestTotal, setRequestTotal] = useState(0);
  const [lens, setLens] = useState<Lens>(() => {
    const saved = localStorage.getItem("cti-profile");
    return LENSES.some((item) => item.id === saved) ? saved as Lens : "developer";
  });
  const [profileOpen, setProfileOpen] = useState(false);
  const [screen, setScreen] = useState<Screen>("brief");
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [chromeMemory, setChromeMemory] = useState<ChromeMemory | null>(null);
  const [browserTabs, setBrowserTabs] = useState<BrowserTab[]>([]);
  const [watchMode, setWatchMode] = useState<"one" | "all" | null>(null);
  const [attachedTabId, setAttachedTabId] = useState<number | null>(null);
  const [extensionLinked, setExtensionLinked] = useState<boolean | null>(null);
  const [hostFilter, setHostFilter] = useState<string | null>(null);
  const pendingTab = useRef<number | null>(null);

  const session = sessions.find((item) => item.id === sessionId) ?? null;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const loadSessions = useCallback(async () => {
    const response = await fetch("/api/sessions");
    if (!response.ok) throw new Error("Collector is not responding");
    const body = await response.json() as { sessions: Session[] };
    setSessions(body.sessions);
    setSessionId((current) => current ?? body.sessions[0]?.id ?? null);
    return body.sessions;
  }, []);

  const loadSession = useCallback(async (id: string, search: string) => {
    const params = search.trim() ? `?q=${encodeURIComponent(search.trim())}` : "";
    const [requestResponse, findingResponse, storageResponse] = await Promise.all([
      fetch(`/api/sessions/${id}/requests${params}`),
      fetch(`/api/sessions/${id}/findings`),
      fetch(`/api/sessions/${id}/storage`),
    ]);
    if (!requestResponse.ok) return;
    const requestBody = await requestResponse.json() as { requests: RequestMeta[]; total?: number };
    const findingBody = await findingResponse.json() as { findings: Finding[] };
    const storageBody = await storageResponse.json() as { storage: StorageSnapshot | null };
    setRequests(requestBody.requests);
    setRequestTotal(requestBody.total ?? requestBody.requests.length);
    setFindings(findingBody.findings);
    setStorage(storageBody.storage);
  }, []);

  useEffect(() => {
    loadSessions().catch((error: Error) => setNotice(error.message));
  }, [loadSessions]);

  function applyRoster(body: { tabs?: BrowserTab[]; attachedTabId?: number | null; watchMode?: string | null }) {
    const mode = body.watchMode === "one" || body.watchMode === "all" ? body.watchMode : null;
    setWatchMode(mode);
    setBrowserTabs(mode ? (body.tabs ?? []) : []);
    setAttachedTabId(typeof body.attachedTabId === "number" ? body.attachedTabId : null);
  }

  useEffect(() => {
    let stop = false;
    async function pullTabs() {
      const direct = await askExtension("tabs");
      if (stop) return;
      if (direct) {
        setExtensionLinked(true);
        applyRoster(direct as { tabs?: BrowserTab[]; attachedTabId?: number | null; watchMode?: string | null });
        return;
      }
      try {
        const response = await fetch("/api/tabs");
        if (!response.ok || stop) return;
        const body = await response.json() as { tabs?: BrowserTab[]; attachedTabId?: number | null; watchMode?: string | null };
        applyRoster(body);
        setExtensionLinked(body.watchMode === "one" || body.watchMode === "all");
      } catch {
        setExtensionLinked(false);
      }
    }
    pullTabs();
    const timer = setInterval(pullTabs, 1000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const handle = setTimeout(() => {
      loadSession(sessionId, query).catch((error: Error) => setNotice(error.message));
    }, 180);
    return () => clearTimeout(handle);
  }, [sessionId, query, loadSession]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${location.host}/live`);
      socket.onopen = () => setConnected(true);
      socket.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as {
          type: string;
          session?: Session;
          sessionId?: string;
          request?: RequestMeta;
          findings?: Finding[];
          storage?: StorageSnapshot | null;
          score?: number;
          tabs?: BrowserTab[];
          attachedTabId?: number | null;
          watchMode?: string | null;
          error?: string;
        };
        if (message.type === "hello" || message.type === "tabs") {
          applyRoster(message);
        }
        if (message.type === "watch-error") setNotice(message.error || "Could not attach to that tab.");
        if (message.type === "session" && message.session) {
          setSessions((current) => {
            const next = current.filter((item) => item.id !== message.session?.id);
            return [message.session as Session, ...next];
          });
          setSessionId((current) => {
            if (pendingTab.current != null && message.session?.tabId === pendingTab.current) {
              pendingTab.current = null;
              return message.session?.id ?? current;
            }
            return current ?? message.session?.id ?? null;
          });
        }
        if (message.type === "request" && message.request && message.sessionId) {
          setSessionId((current) => current ?? message.sessionId ?? null);
          setRequests((current) => {
            const active = sessionIdRef.current;
            if (active && message.sessionId !== active) return current;
            return upsert(current, message.request as RequestMeta);
          });
        }
        if (message.type === "audit" && message.sessionId) {
          setSessions((current) => current.map((item) => (
            item.id === message.sessionId
              ? { ...item, score: message.score ?? item.score, findingCount: message.findings?.length ?? item.findingCount }
              : item
          )));
          if (!sessionIdRef.current || message.sessionId === sessionIdRef.current) {
            if (message.findings) setFindings(message.findings);
            if (message.storage) setStorage(message.storage);
          }
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    const url = session?.tabUrl;
    if (!url) {
      setDossier(null);
      setChromeMemory(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/dossier?url=${encodeURIComponent(url)}`)
      .then((response) => response.ok ? response.json() : null)
      .then((body: Dossier | null) => {
        if (!cancelled && body?.page) setDossier(body);
      })
      .catch(() => {});
    askExtension("page-memory", { url }).then((body) => {
      if (!cancelled) setChromeMemory((body as ChromeMemory | null) ?? { available: false });
    });
    return () => {
      cancelled = true;
    };
  }, [session?.tabUrl, session?.updatedAt, session?.id]);

  useEffect(() => {
    if (!sessionId || !selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/requests/${encodeURIComponent(selectedId)}`)
      .then((response) => response.ok ? response.json() : null)
      .then((body: { request: RequestDetail } | null) => {
        if (!cancelled && body) setDetail(body.request);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, selectedId]);

  const visible = useMemo(() => {
    return requests.filter((request) => {
      if (hostFilter && requestHost(request) !== hostFilter) return false;
      if (filter === "errors") return (request.status ?? 0) >= 400 || Boolean(request.error);
      if (filter === "slow") return (request.latencyMs ?? 0) >= 500;
      return true;
    });
  }, [requests, filter, hostFilter]);

  const lead = useMemo(() => {
    const order: Record<string, number> = { critical: 0, high: 1, medium: 2 };
    return [...findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))[0] ?? null;
  }, [findings]);

  const stats = useMemo(() => summarize(visible), [visible]);
  const timing = useMemo(() => buckets(visible), [visible]);
  const payloadRows = useMemo(
    () => bytesByEndpoint(visible).map((row) => ({ label: row.endpoint, value: row.bytes })),
    [visible],
  );
  const score = session?.score ?? 100;
  const flow = useMemo(() => trafficFlow(requests, session?.tabUrl ?? null), [requests, session?.tabUrl]);
  const health = useMemo(() => endpointHealth(visible), [visible]);

  function focusWatched(tabId: number) {
    const known = sessions.find((item) => item.tabId === tabId);
    if (!known) return;
    setSessionId(known.id);
    setSelectedId(null);
    setQuery("");
    setHostFilter(null);
    setScreen("brief");
  }

  async function watchTab(tabId: number) {
    setNotice("");
    pendingTab.current = tabId;
    const known = sessions.find((item) => item.tabId === tabId);
    if (known) {
      setSessionId(known.id);
      setSelectedId(null);
      setQuery("");
      setHostFilter(null);
    }
    const direct = await askExtension("inspect", { tabId });
    if (direct && !direct.error && direct.attachedTabId === tabId) {
      setAttachedTabId(tabId);
      setExtensionLinked(true);
      setNotice("Streaming this tab. Chrome keeps the debugging banner on it.");
      return;
    }
    const response = await fetch("/api/watch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tabId }),
    });
    const body = await response.json() as { error?: string };
    if (direct?.error) setNotice(String(direct.error));
    else if (!response.ok) setNotice(body.error || "Could not watch that tab.");
    else setNotice("Streaming this tab. Chrome keeps the debugging banner on it.");
  }

  async function refreshDossier() {
    const url = session?.tabUrl;
    if (!url) return;
    const response = await fetch(`/api/dossier?url=${encodeURIComponent(url)}`);
    if (response.ok) setDossier(await response.json() as Dossier);
  }

  async function forgetHistory(scope: "ledger" | "captures") {
    if (!dossier) return;
    const prompt = scope === "captures"
      ? `Delete every captured session for ${dossier.page.host}? This removes requests, findings, and the ledger on this machine.`
      : `Forget the inspector ledger for ${dossier.page.host}? Captured sessions stay until you delete them.`;
    if (!window.confirm(prompt)) return;
    const response = await fetch(`/api/history?host=${encodeURIComponent(dossier.page.host)}&scope=${scope}`, { method: "DELETE" });
    if (!response.ok) {
      setNotice("Could not delete that record.");
      return;
    }
    if (scope === "captures") {
      setSessionId(null);
      setSelectedId(null);
      await loadSessions();
    }
    await refreshDossier();
    setNotice(scope === "captures" ? "Captured sessions for this host were deleted." : "Inspector ledger for this host was forgotten. Chrome history was not touched.");
  }

  function pickLens(next: Lens) {
    setLens(next);
    localStorage.setItem("cti-profile", next);
    setProfileOpen(false);
  }

  async function copyReport() {
    if (!sessionId) return;
    const response = await fetch(`/api/sessions/${sessionId}/report.md`);
    const text = await response.text();
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Audit markdown copied.");
    } catch {
      window.open(`/api/sessions/${sessionId}/report.md`, "_blank");
    }
  }

  const thisWindow = browserTabs.filter((tab) => tab.focusedWindow !== false);
  const otherWindows = browserTabs.filter((tab) => tab.focusedWindow === false);
  const hosts = [...flow.sameSite, ...flow.eastWest];
  const recent = [...visible].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, 8);
  const watching = !session
    ? "Pick a tab on the left. The capture starts when you click it."
    : requests.length === 0
      ? `Attached at ${formatClock(session.startedAt)}. Nothing new yet. Use the page or reload it. Calls that already finished are not replayed.`
      : `Watching since ${formatClock(session.startedAt)}. ${requests.length} call${requests.length === 1 ? "" : "s"} captured after attach.`;

  return (
    <div className="shell">
      <nav className="fleet" aria-label="Open tabs in this Chrome">
        <div className="fleet-head">
          <p className="mark">Watching</p>
          <p className={watchMode ? "fleet-status on" : "fleet-status"}>
            {watchMode === "all" ? "All tabs" : watchMode === "one" ? "One tab" : "Set in the extension"}
          </p>
        </div>
        <div className="fleet-list">
          {!watchMode ? (
            <div className="fleet-empty">
              <p>This dashboard does not list your tabs. Choose the watch mode on the extension icon first.</p>
              <ol>
                <li>Click the Inspector icon in Chrome</li>
                <li>Choose one tab at a time, or all open tabs</li>
                <li>Only the tabs you watch appear here</li>
              </ol>
            </div>
          ) : browserTabs.length === 0 ? (
            <div className="fleet-empty">
              <p>{watchMode === "all" ? "Confirm Watch all open tabs in the extension." : "Click one tab in the extension. It will show up here."}</p>
            </div>
          ) : (
            <>
              <TabGroup label={watchMode === "all" ? "Watched tabs" : "This tab"} tabs={thisWindow} attachedTabId={attachedTabId} sessions={sessions} onWatch={focusWatched} />
              {otherWindows.length ? (
                <TabGroup label="Other windows" tabs={otherWindows} attachedTabId={attachedTabId} sessions={sessions} onWatch={focusWatched} />
              ) : null}
            </>
          )}
        </div>
        <p className="fleet-foot">Chrome keeps its debugging banner on every tab the extension is watching.</p>
      </nav>
    <div className="app">
      <header className="top">
        <p className="mark">Inspector</p>
        <span className={connected ? "live on" : "live"}>{connected ? "Live" : "Offline"}</span>
        <div className="actions">
          <select
            aria-label="Earlier capture"
            value={sessionId ?? ""}
            onChange={(event) => {
              setSessionId(event.target.value || null);
              setSelectedId(null);
            }}
          >
            <option value="">Earlier capture</option>
            {sessions.map((item) => (
              <option key={item.id} value={item.id}>
                {(item.tabTitle || hostOf(item.tabUrl))} · {formatClock(item.startedAt)}
              </option>
            ))}
          </select>
          <button type="button" className="ghost" onClick={copyReport} disabled={!sessionId}>Copy report</button>
          <a className={sessionId ? "button ghost" : "button ghost disabled"} href={sessionId ? `/api/sessions/${sessionId}/har` : undefined}>
            Export HAR
          </a>
          <ProfileMenu lens={lens} open={profileOpen} onToggle={() => setProfileOpen((open) => !open)} onPick={pickLens} />
        </div>
      </header>

      <section className="brief">
        <div>
          <p className="eyebrow">{session?.tabTitle || "No tab"}</p>
          <h1>{session ? hostOf(session.tabUrl) : "Pick a tab"}</h1>
          <p className="lede">{watching}</p>
          {session?.tabUrl ? <p className="url">{session.tabUrl}</p> : null}
        </div>
        <div className="verdict" aria-label="Capture summary">
          <div>
            <strong className={score >= 80 ? "ok" : score >= 60 ? "warn" : "bad"}>{session ? score : "—"}</strong>
            <span>Score</span>
          </div>
          <div>
            <strong>{session ? stats.count : "—"}</strong>
            <span>Calls</span>
          </div>
          <div>
            <strong className={stats.errors ? "bad" : ""}>{session ? stats.errors : "—"}</strong>
            <span>Failed</span>
          </div>
          <div>
            <strong>{session ? hosts.length : "—"}</strong>
            <span>Hosts</span>
          </div>
        </div>
      </section>

      <article className={lead ? `lead ${lead.severity}` : "lead quiet"}>
        {lead ? (
          <>
            <p className="eyebrow">{lead.severity} · the finding that matters</p>
            <h2>{lead.title}</h2>
            <p>{lead.detail}</p>
          </>
        ) : (
          <>
            <p className="eyebrow">Findings</p>
            <h2>{session ? "Nothing has failed a check on this capture." : "The finding shows up here."}</h2>
            <p>{session ? "A clean capture stays at 100 until a rule fires." : "Attach a tab you own. The score and the first real finding replace this line."}</p>
          </>
        )}
      </article>

      {notice ? <p className="notice">{notice}</p> : null}

      <div className="screen-nav" role="tablist" aria-label="Section">
        {([
          ["brief", "Brief"],
          ["calls", "Calls"],
          ["changes", "What changed"],
          ["record", "Record"],
        ] as const).map(([id, label]) => (
          <button key={id} type="button" className={screen === id ? "on" : ""} onClick={() => setScreen(id)}>
            {label}
          </button>
        ))}
      </div>

      {screen === "brief" && lens === "devops" ? (
        <>
          <section className="charts">
            <article>
              <h2>Latency</h2>
              {timing ? <LatencyChart labels={timing.labels} p50={timing.p50} p95={timing.p95} unit={timing.unit} /> : <EmptyChart />}
              <p className="caption">p50 and p95 for this capture. The dashed line is 500 ms.</p>
            </article>
            <article>
              <h2>Failures</h2>
              {timing ? <ErrorChart labels={timing.labels} values={timing.errors} unit={timing.unit} /> : <EmptyChart />}
              <p className="caption">Responses at status 400 or higher.</p>
            </article>
            <article>
              <h2>Size</h2>
              {payloadRows.length ? <BytesChart rows={payloadRows} unit="bytes" /> : <EmptyChart />}
              <p className="caption">Largest response paths in this capture.</p>
            </article>
          </section>
          <DevopsTable rows={health} />
        </>
      ) : null}
      {screen === "brief" && lens === "user" ? (
        <UserFeed requests={visible} findings={findings} onPick={setSelectedId} />
      ) : null}
      {screen === "brief" && (lens === "white" || lens === "gray" || lens === "black") ? (
        <SecurityBoard lens={lens} findings={findings} storage={storage} />
      ) : null}
      {screen === "brief" && lens === "developer" ? (
        <div className="stage">
          <section>
            <h2>Hosts</h2>
            {hosts.length === 0 ? <p className="panel-empty">Hosts appear after the first call.</p> : (
              <ul className="host-list">
                <li>
                  <button type="button" className={hostFilter ? "host" : "host on"} onClick={() => setHostFilter(null)}>
                    <strong>All hosts</strong>
                    <span>{requests.length} calls</span>
                  </button>
                </li>
                {hosts.map((host) => (
                  <li key={host.host}>
                    <button
                      type="button"
                      className={hostFilter === host.host ? "host on" : "host"}
                      onClick={() => setHostFilter(hostFilter === host.host ? null : host.host)}
                    >
                      <strong>{host.host}</strong>
                      <span>{host.sameSite ? "This site" : "Other host"} · {host.out} calls · {formatBytes(host.bytes)}{host.errors ? ` · ${host.errors} failed` : ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2>Latest calls</h2>
            {recent.length === 0 ? <p className="panel-empty">No calls in this view yet.</p> : (
              <ul className="latest">
                {recent.map((request) => (
                  <li key={request.requestId}>
                    <button type="button" className={request.requestId === selectedId ? "on" : ""} onClick={() => setSelectedId(request.requestId)}>
                      <span className={statusClass(request.status)}>{request.status || "…"}</span>
                      <span className="mono">{request.method}</span>
                      <span className="grow">{request.endpoint}</span>
                      <span>{formatMs(request.latencyMs)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <RequestDetailView detail={detail} />
          </section>
        </div>
      ) : null}

      {screen === "changes" ? <CompareBoard dossier={dossier} /> : null}

      {screen === "record" ? (
        <>
          <HistoryBoard
            dossier={dossier}
            memory={chromeMemory}
            onOpen={(id) => {
              setSessionId(id);
              setScreen("brief");
              setSelectedId(null);
            }}
            onForgetLedger={() => forgetHistory("ledger")}
            onForgetCaptures={() => forgetHistory("captures")}
          />
          <TestBoard dossier={dossier} onRun={() => refreshDossier().catch(() => setNotice("Could not run the checks again."))} />
        </>
      ) : null}

      {screen === "calls" ? <>
        {lens === "devops" ? (
          <section className="charts">
            <article>
              <h2>API latency</h2>
              {timing ? <LatencyChart labels={timing.labels} p50={timing.p50} p95={timing.p95} unit={timing.unit} /> : <EmptyChart />}
            </article>
            <article>
              <h2>Failed responses</h2>
              {timing ? <ErrorChart labels={timing.labels} values={timing.errors} unit={timing.unit} /> : <EmptyChart />}
            </article>
            <article>
              <h2>Payload by endpoint</h2>
              {payloadRows.length ? <BytesChart rows={payloadRows} unit="bytes" /> : <EmptyChart />}
            </article>
          </section>
        ) : null}
        {lens === "devops" ? <DevopsTable rows={health} /> : null}
        {lens === "user" ? (
          <>
            <UserFeed requests={visible} findings={findings} onPick={setSelectedId} />
            {detail ? <RequestDetailView detail={detail} /> : null}
          </>
        ) : null}
        {lens === "white" || lens === "gray" || lens === "black" ? (
          <SecurityBoard lens={lens} findings={findings} storage={storage} />
        ) : null}
        {lens === "developer" || lens === "devops" ? (
          <div className="workspace">
            <section className="stream">
              <div className="toolbar">
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search URL or body"
                  aria-label="Search URL or body"
                />
                <div className="filters" role="group" aria-label="Filter requests">
                  {(["all", "errors", "slow"] as Filter[]).map((item) => (
                    <button key={item} type="button" className={filter === item ? "chip on" : "chip"} onClick={() => setFilter(item)}>
                      {item === "all" ? "All" : item === "errors" ? "Errors" : "Slow"}
                    </button>
                  ))}
                </div>
              </div>
              {requestTotal > requests.length ? (
                <p className="caption">Showing {requests.length} of {requestTotal} captured calls.</p>
              ) : null}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Method</th>
                      <th>Status</th>
                      <th>Endpoint</th>
                      <th>Host</th>
                      <th>Latency</th>
                      <th>Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="empty">No calls match.</td>
                      </tr>
                    ) : visible.map((request) => (
                      <tr
                        key={request.requestId}
                        className={request.requestId === selectedId ? "selected" : undefined}
                        onClick={() => setSelectedId(request.requestId)}
                      >
                        <td>{formatClock(request.startedAt)}</td>
                        <td className="mono">{request.method}</td>
                        <td className={statusClass(request.status)}>{request.status || request.error || "—"}</td>
                        <td className="endpoint" title={request.url ?? ""}>{request.endpoint}</td>
                        <td>{requestHost(request) === flow.pageHost ? "This site" : "Other host"}</td>
                        <td>{formatMs(request.latencyMs)}</td>
                        <td>{formatBytes(request.size)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <RequestDetailView detail={detail} />
            </section>
            <aside>
              <div className="filters" role="group" aria-label="Audit panels">
                <button type="button" className={panel === "findings" ? "chip on" : "chip"} onClick={() => setPanel("findings")}>Findings</button>
                <button type="button" className={panel === "storage" ? "chip on" : "chip"} onClick={() => setPanel("storage")}>Storage</button>
              </div>
              {panel === "findings" ? <Findings findings={findings} ready={Boolean(session)} /> : <StorageView storage={storage} />}
            </aside>
          </div>
        ) : null}
      </> : null}
    </div>
    </div>
  );
}

function TabGroup({
  label,
  tabs,
  attachedTabId,
  sessions,
  onWatch,
}: {
  label: string;
  tabs: BrowserTab[];
  attachedTabId: number | null;
  sessions: Session[];
  onWatch: (tabId: number) => void;
}) {
  if (!tabs.length) return null;
  return (
    <div>
      <p className="fleet-group">{label}</p>
      {tabs.map((tab) => {
        const live = tab.tabId === attachedTabId || tab.attached;
        const known = sessions.find((item) => item.tabId === tab.tabId);
        let host = "Loading";
        try {
          host = tab.url ? new URL(tab.url).host : "Loading";
        } catch {
          host = tab.url || "Loading";
        }
        const mark = (tab.title || host || "?").trim().charAt(0).toUpperCase();
        return (
          <button
            key={tab.tabId}
            type="button"
            className={live ? "tab-row live" : "tab-row"}
            onClick={() => onWatch(tab.tabId)}
          >
            {tab.favIconUrl ? (
              <img className="tab-mark" src={tab.favIconUrl} alt="" />
            ) : (
              <span className="tab-mark">{mark}</span>
            )}
            <span className="tab-copy">
              <strong>{tab.title || host}</strong>
              <small>
                {live ? "Live · " : tab.active ? "Front · " : ""}
                {host}
                {known ? ` · ${known.requestCount} calls · score ${known.score}` : ""}
              </small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Score({ value }: { value: number | null }) {
  const tone = value == null ? "muted" : value >= 80 ? "ok" : value >= 60 ? "warn" : "bad";
  return (
    <div className="metric score">
      <strong className={tone}>{value == null ? "—" : value}</strong>
      <span>Audit score</span>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="metric">
      <strong className={tone}>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function EmptyChart() {
  return <p className="chart-empty">Waiting for traffic.</p>;
}

function Findings({ findings, ready }: { findings: Finding[]; ready: boolean }) {
  if (!ready) {
    return <p className="panel-empty">Load a session to score the tab.</p>;
  }
  if (!findings.length) {
    return <p className="panel-empty">No rules have fired. A clean session still gets a score of 100.</p>;
  }
  const order = { critical: 0, high: 1, medium: 2 };
  const sorted = [...findings].sort((a, b) => (order[a.severity as keyof typeof order] ?? 9) - (order[b.severity as keyof typeof order] ?? 9));
  return (
    <ol className="findings">
      {sorted.map((finding) => (
        <li key={finding.id}>
          <span className={`sev ${finding.severity}`}>{finding.severity}</span>
          <h3>{finding.title}</h3>
          <p>{finding.detail}</p>
        </li>
      ))}
    </ol>
  );
}

function StorageView({ storage }: { storage: StorageSnapshot | null }) {
  if (!storage) return <p className="panel-empty">Storage appears after the extension snapshots the attached tab.</p>;
  return (
    <div className="storage">
      <p className="caption">{storage.origin}</p>
      <h3>localStorage</h3>
      <EntryList rows={storage.localStorage} />
      <h3>sessionStorage</h3>
      <EntryList rows={storage.sessionStorage} />
      <h3>Cookies</h3>
      {storage.cookies.length === 0 ? <p className="panel-empty">No cookies on this origin.</p> : (
        <ul className="cookies">
          {storage.cookies.map((cookie) => (
            <li key={cookie.name}>
              <strong>{cookie.name}</strong>
              <span>{cookie.httpOnly ? "HttpOnly" : "Readable by JS"}</span>
              <span>{cookie.secure ? "Secure" : "Not Secure"}</span>
              <span>SameSite {cookie.sameSite}</span>
              <code>{cookie.value}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EntryList({ rows }: { rows: { key: string; value: string }[] }) {
  if (!rows.length) return <p className="panel-empty">Empty.</p>;
  return (
    <ul className="entries">
      {rows.map((row) => (
        <li key={row.key}>
          <strong>{row.key}</strong>
          <code>{row.value}</code>
        </li>
      ))}
    </ul>
  );
}

function RequestDetailView({ detail }: { detail: RequestDetail | null }) {
  if (!detail) return <p className="detail empty">Select a request to read headers and body previews. Secrets are redacted before they are stored.</p>;
  return (
    <div className="detail">
      <p className="mono url-line">{detail.method} {detail.url}</p>
      <div className="split">
        <HeaderBlock title="Request headers" headers={detail.requestHeaders} />
        <HeaderBlock title="Response headers" headers={detail.responseHeaders} />
      </div>
      <div className="split">
        <BodyBlock title="Request body" text={detail.requestBody} />
        <BodyBlock title="Response body" text={detail.responseBody} truncated={detail.truncated} />
      </div>
    </div>
  );
}

function HeaderBlock({ title, headers }: { title: string; headers: { name: string; value: string }[] }) {
  return (
    <div>
      <h3>{title}</h3>
      {headers?.length ? (
        <ul className="headers">
          {headers.map((header) => (
            <li key={header.name + header.value}><span>{header.name}</span><code>{header.value}</code></li>
          ))}
        </ul>
      ) : <p className="panel-empty">None captured.</p>}
    </div>
  );
}

function BodyBlock({ title, text, truncated }: { title: string; text: string | null; truncated?: boolean }) {
  return (
    <div>
      <h3>{title}{truncated ? " · truncated" : ""}</h3>
      <pre>{text || "No body stored. Bodies over 64 KB keep their size only."}</pre>
    </div>
  );
}

function upsert(list: RequestMeta[], row: RequestMeta) {
  const index = list.findIndex((item) => item.requestId === row.requestId);
  if (index === -1) return [...list, row].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const next = list.slice();
  next[index] = row;
  return next;
}
