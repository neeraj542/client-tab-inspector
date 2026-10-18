import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  tab_url TEXT,
  tab_title TEXT,
  score INTEGER NOT NULL DEFAULT 100
);
CREATE TABLE IF NOT EXISTS requests (
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  method TEXT,
  url TEXT,
  endpoint TEXT,
  type TEXT,
  status INTEGER,
  status_text TEXT,
  mime TEXT,
  latency_ms REAL,
  size INTEGER,
  request_headers TEXT,
  response_headers TEXT,
  request_body TEXT,
  response_body TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at REAL,
  PRIMARY KEY (session_id, request_id)
);
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  finding_key TEXT NOT NULL UNIQUE,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  subject TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  session_id TEXT PRIMARY KEY,
  origin TEXT,
  local_storage TEXT,
  session_storage TEXT,
  cookies TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS visits (
  session_id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  domain TEXT NOT NULL,
  path TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_findings_session ON findings(session_id, id);
CREATE TABLE IF NOT EXISTS ledger_skip (
  session_id TEXT PRIMARY KEY
);
CREATE INDEX IF NOT EXISTS idx_visits_host ON visits(host, seen_at);
`;

export function openStore(filename) {
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  if (filename !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  const columns = db.prepare("PRAGMA table_info(sessions)").all();
  if (!columns.some((column) => column.name === "tab_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN tab_id INTEGER");
  }
  return db;
}

export function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    tabUrl: row.tab_url,
    tabTitle: row.tab_title,
    tabId: row.tab_id ?? null,
    score: row.score,
    requestCount: row.request_count ?? 0,
    findingCount: row.finding_count ?? 0,
  };
}

export function mapRequest(row, { includeBodies = false } = {}) {
  const base = {
    requestId: row.request_id,
    method: row.method,
    url: row.url,
    endpoint: row.endpoint,
    type: row.type,
    status: row.status,
    statusText: row.status_text,
    mime: row.mime,
    latencyMs: row.latency_ms,
    size: row.size,
    error: row.error,
    startedAt: row.started_at,
    truncated: Boolean(row.truncated),
    hasRequestBody: Boolean(row.has_request_body ?? row.request_body),
    hasResponseBody: Boolean(row.has_response_body ?? row.response_body),
  };
  if (!includeBodies) return base;
  return {
    ...base,
    requestHeaders: parseJson(row.request_headers, []),
    responseHeaders: parseJson(row.response_headers, []),
    requestBody: row.request_body,
    responseBody: row.response_body,
  };
}

export function mapFinding(row) {
  return {
    id: row.id,
    rule: row.rule,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    subject: row.subject,
    createdAt: row.created_at,
  };
}

export function mapSnapshot(row) {
  if (!row) return null;
  return {
    origin: row.origin,
    localStorage: parseJson(row.local_storage, []),
    sessionStorage: parseJson(row.session_storage, []),
    cookies: parseJson(row.cookies, []),
    updatedAt: row.updated_at,
  };
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
