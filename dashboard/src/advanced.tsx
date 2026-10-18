import { useEffect, useRef } from "react";
import { formatClock } from "./format";
import { LENSES, type Lens } from "./lenses";
import type { Session } from "./types";

export type Mode = "live" | "history" | "compare" | "test";
export type MethodFilter = "ALL" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type StatusBand = "all" | "2xx" | "3xx" | "4xx" | "5xx";
export type KindFilter = "all" | "fetch" | "script" | "document" | "image" | "other";
export type WayFilter = "all" | "same" | "cross";

export type DossierVisit = {
  sessionId: string;
  url: string;
  path: string;
  title: string | null;
  seenAt: number;
  host: string;
};

export type Dossier = {
  page: {
    href: string;
    origin: string;
    host: string;
    domain: string;
    path: string;
    protocol: string;
  };
  ledger: {
    visits: number;
    hostVisits: number;
    firstSeen: number | null;
    lastSeen: number | null;
    hostFirstSeen: number | null;
    hostLastSeen: number | null;
    pages: DossierVisit[];
  };
  sessions: Session[];
  updates: {
    previousSessionId: string | null;
    previousAt: number | null;
    scoreDelta: number | null;
    added: string[];
    removed: string[];
    changed: string[];
  };
  headers: { name: string; value: string }[];
  signals: { name: string; value: string }[];
  tests: { id: string; name: string; status: "pass" | "fail" | "unknown"; detail: string }[];
};

export type ChromeMemory = {
  available: boolean;
  lastVisitTime?: number | null;
  visitCount?: number;
  pages?: { url: string; title: string; lastVisitTime: number | null; visitCount: number }[];
  error?: string;
};

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "live", label: "Live", hint: "Stream of the selected tab" },
  { id: "history", label: "History", hint: "When this page was seen" },
  { id: "compare", label: "Updates", hint: "What changed since last capture" },
  { id: "test", label: "Test", hint: "Pass and fail on this capture" },
];

export function ProfileMenu({
  lens,
  open,
  onToggle,
  onPick,
}: {
  lens: Lens;
  open: boolean;
  onToggle: () => void;
  onPick: (lens: Lens) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const current = LENSES.find((item) => item.id === lens) ?? LENSES[0];
  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) onToggle();
    }
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open, onToggle]);
  return (
    <div className="profile" ref={root}>
      <button type="button" className="profile-button" aria-expanded={open} aria-haspopup="menu" onClick={onToggle}>
        <span className="profile-mark">{current.label.slice(0, 1)}</span>
        <span>
          <strong>{current.label}</strong>
          <small>Profile</small>
        </span>
      </button>
      {open ? (
        <div className="profile-menu" role="menu" aria-label="View profile">
          {LENSES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === lens}
              className={item.id === lens ? "on" : ""}
              onClick={() => onPick(item.id)}
            >
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ModeBar({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  return (
    <div className="mode-bar" role="tablist" aria-label="Workspace mode">
      {MODES.map((item) => (
        <button key={item.id} type="button" className={mode === item.id ? "on" : ""} onClick={() => onChange(item.id)}>
          {item.label}
          <small>{item.hint}</small>
        </button>
      ))}
    </div>
  );
}

export function FilterStrip({
  method,
  status,
  kind,
  way,
  onMethod,
  onStatus,
  onKind,
  onWay,
  onReset,
}: {
  method: MethodFilter;
  status: StatusBand;
  kind: KindFilter;
  way: WayFilter;
  onMethod: (value: MethodFilter) => void;
  onStatus: (value: StatusBand) => void;
  onKind: (value: KindFilter) => void;
  onWay: (value: WayFilter) => void;
  onReset: () => void;
}) {
  return (
    <div className="filter-strip" aria-label="Request filters">
      <Select label="Method" value={method} options={["ALL", "GET", "POST", "PUT", "PATCH", "DELETE"]} onChange={onMethod} />
      <Select label="Status" value={status} options={["all", "2xx", "3xx", "4xx", "5xx"]} onChange={onStatus} />
      <Select label="Type" value={kind} options={["all", "fetch", "script", "document", "image", "other"]} onChange={onKind} />
      <Select label="Path" value={way} options={["all", "same", "cross"]} onChange={onWay} />
      <button type="button" className="ghost" onClick={onReset}>Reset filters</button>
    </div>
  );
}

export function DossierStrip({ dossier, memory }: { dossier: Dossier | null; memory: ChromeMemory | null }) {
  if (!dossier) {
    return <p className="caption">Pick a tab or a session to open its page record.</p>;
  }
  const chromeGone = memory?.available && !memory.lastVisitTime;
  return (
    <section className="dossier" aria-label="Page record">
      <article>
        <span>Domain</span>
        <strong>{dossier.page.domain}</strong>
        <small>{dossier.page.protocol} · {dossier.page.host}</small>
      </article>
      <article>
        <span>Page</span>
        <strong>{dossier.page.path}</strong>
        <small>{dossier.ledger.visits} inspector visit{dossier.ledger.visits === 1 ? "" : "s"}</small>
      </article>
      <article>
        <span>Last inspector visit</span>
        <strong>{formatWhen(dossier.ledger.lastSeen)}</strong>
        <small>First seen {formatWhen(dossier.ledger.firstSeen)}</small>
      </article>
      <article>
        <span>Chrome history</span>
        <strong>{memory?.available ? formatWhen(memory.lastVisitTime) : "Not linked"}</strong>
        <small>
          {chromeGone
            ? "Chrome has no visit. The inspector record above still stands."
            : memory?.available
              ? `${memory.visitCount ?? 0} Chrome visits on this host`
              : "Reload the extension to read Chrome history."}
        </small>
      </article>
      <article>
        <span>Since previous capture</span>
        <strong>{deltaLabel(dossier.updates.scoreDelta)}</strong>
        <small>{dossier.updates.added.length} new · {dossier.updates.removed.length} gone · {dossier.updates.changed.length} status changes</small>
      </article>
    </section>
  );
}

export function HistoryBoard({
  dossier,
  memory,
  onOpen,
  onForgetLedger,
  onForgetCaptures,
}: {
  dossier: Dossier | null;
  memory: ChromeMemory | null;
  onOpen: (sessionId: string) => void;
  onForgetLedger: () => void;
  onForgetCaptures: () => void;
}) {
  if (!dossier) return <p className="panel-empty">No page is selected.</p>;
  return (
    <section className="board">
      <header className="board-head">
        <div>
          <h2>History for {dossier.page.host}</h2>
          <p className="caption">
            The inspector keeps this ledger on localhost. Clearing Chrome history does not erase it.
            Chrome’s own history, once deleted there, cannot be rebuilt from this tool.
          </p>
        </div>
        <div className="actions">
          <button type="button" className="ghost" onClick={onForgetLedger}>Forget inspector ledger</button>
          <button type="button" className="ghost" onClick={onForgetCaptures}>Delete captured sessions</button>
        </div>
      </header>
      <div className="board-grid">
        <div>
          <h3>Inspector</h3>
          {dossier.ledger.pages.length === 0 ? <p className="panel-empty">No local visits for this host.</p> : (
            <ol className="timeline">
              {dossier.ledger.pages.map((visit) => (
                <li key={visit.sessionId}>
                  <button type="button" onClick={() => onOpen(visit.sessionId)}>
                    <time>{formatWhen(visit.seenAt)}</time>
                    <strong>{visit.title || visit.path}</strong>
                    <small>{visit.path}</small>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div>
          <h3>Still in Chrome</h3>
          {!memory?.available ? <p className="panel-empty">Chrome history is unavailable until the extension is reloaded.</p> : null}
          {memory?.available && !memory.pages?.length ? <p className="panel-empty">Chrome history has no pages left for this host.</p> : null}
          {memory?.pages?.length ? (
            <ol className="timeline">
              {memory.pages.map((page) => (
                <li key={page.url}>
                  <div>
                    <time>{formatWhen(page.lastVisitTime)}</time>
                    <strong>{page.title || page.url}</strong>
                    <small>{page.visitCount} Chrome visit{page.visitCount === 1 ? "" : "s"}</small>
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function CompareBoard({ dossier }: { dossier: Dossier | null }) {
  if (!dossier) return <p className="panel-empty">No page is selected.</p>;
  const { updates, signals, headers } = dossier;
  return (
    <section className="board">
      <header className="board-head">
        <div>
          <h2>What changed on {dossier.page.path}</h2>
          <p className="caption">
            {updates.previousAt
              ? `Compared with the capture from ${formatWhen(updates.previousAt)}. ${deltaLabel(updates.scoreDelta)}.`
              : "No earlier capture of this host yet. The next visit shows what appeared, what disappeared, and which statuses changed."}
          </p>
        </div>
      </header>
      <div className="board-grid three">
        <ChangeList title="New endpoints" rows={updates.added} empty="No new endpoints." />
        <ChangeList title="Gone" rows={updates.removed} empty="Nothing disappeared." />
        <ChangeList title="Status changed" rows={updates.changed} empty="Statuses match the previous capture." />
      </div>
      <div className="signal-row">
        {signals.length === 0 ? <p className="caption">No server or platform header was stored on the captured responses.</p> : signals.map((signal) => (
          <span key={signal.name} className="signal"><strong>{signal.name}</strong> {signal.value}</span>
        ))}
        {headers.slice(0, 6).map((header) => (
          <span key={header.name} className="signal"><strong>{header.name}</strong> {header.value}</span>
        ))}
      </div>
    </section>
  );
}

export function TestBoard({ dossier, onRun }: { dossier: Dossier | null; onRun: () => void }) {
  if (!dossier) return <p className="panel-empty">No page is selected.</p>;
  const failed = dossier.tests.filter((test) => test.status === "fail").length;
  const passed = dossier.tests.filter((test) => test.status === "pass").length;
  return (
    <section className="board">
      <header className="board-head">
        <div>
          <h2>Tests for this capture</h2>
          <p className="caption">{passed} passed · {failed} failed. These checks describe what was observed. They do not show how to abuse it.</p>
        </div>
        <button type="button" onClick={onRun}>Run again</button>
      </header>
      <ol className="tests">
        {dossier.tests.map((test) => (
          <li key={test.id} className={test.status}>
            <span className={`sev ${test.status}`}>{test.status}</span>
            <div>
              <strong>{test.name}</strong>
              <p>{test.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ChangeList({ title, rows, empty }: { title: string; rows: string[]; empty: string }) {
  return (
    <div>
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="panel-empty">{empty}</p> : (
        <ul className="changes">
          {rows.map((row) => <li key={row}><code>{row}</code></li>)}
        </ul>
      )}
    </div>
  );
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="filter-field">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function formatWhen(value: number | null | undefined) {
  if (value == null || value === 0) return "No record";
  const date = new Date(value);
  const sameDay = date.toDateString() === new Date().toDateString();
  if (sameDay) return `Today ${formatClock(value)}`;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function deltaLabel(delta: number | null) {
  if (delta == null) return "No prior capture";
  if (delta === 0) return "Score unchanged";
  return delta > 0 ? `Score +${delta}` : `Score ${delta}`;
}
