import {
  endpointOf,
  looksLikeJwt,
  proof,
  redactBody,
  redactHeaders,
  redactUrl,
  sessionLikeCookie,
} from "./redact.mjs";
import { rememberVisit } from "./dossier.mjs";
import { createRuleState, evaluateEvent, markRequestDone, scoreFromFindings } from "./rules.mjs";

const BODY_CAP = 64 * 1024;

export function createPipeline(db) {
  const states = new Map();

  function stateFor(sessionId) {
    let state = states.get(sessionId);
    if (!state) {
      state = createRuleState();
      states.set(sessionId, state);
    }
    return state;
  }

  function ensureSession(session) {
    const now = Date.now();
    const existing = db.prepare("SELECT id FROM sessions WHERE id = ?").get(session.id);
    if (!existing) {
      db.prepare(`
        INSERT INTO sessions (id, started_at, updated_at, tab_url, tab_title, tab_id, score)
        VALUES (?, ?, ?, ?, ?, ?, 100)
      `).run(session.id, now, now, session.url ?? null, session.title ?? null, session.tabId ?? null);
      return;
    }
    db.prepare(`
      UPDATE sessions
      SET updated_at = ?,
          tab_url = COALESCE(?, tab_url),
          tab_title = COALESCE(?, tab_title),
          tab_id = COALESCE(?, tab_id)
      WHERE id = ?
    `).run(now, session.url ?? null, session.title ?? null, session.tabId ?? null, session.id);
  }

  function existingFindingKeys(sessionId) {
    const rows = db.prepare("SELECT finding_key FROM findings WHERE session_id = ?").all(sessionId);
    return new Set(rows.map((row) => row.finding_key));
  }

  function ingest(session, events) {
    if (!session?.id) throw new Error("session id required");
    const accepted = [];
    const createdFindings = [];
    db.exec("BEGIN");
    try {
      ensureSession(session);
      rememberVisit(db, session);
      const known = existingFindingKeys(session.id);
      const state = stateFor(session.id);
      for (const event of events ?? []) {
        const result = applyEvent(session.id, state, event, known);
        if (result.request) accepted.push(result.request);
        createdFindings.push(...result.findings);
      }
      const findings = listFindings(session.id);
      const score = scoreFromFindings(findings);
      db.prepare("UPDATE sessions SET score = ?, updated_at = ? WHERE id = ?")
        .run(score, Date.now(), session.id);
      db.exec("COMMIT");
      return {
        session: getSession(session.id),
        requests: accepted,
        findings,
        storage: getSnapshot(session.id),
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function applyEvent(sessionId, state, event, known) {
    let current = event;
    if ((event.kind === "net.response" || event.kind === "net.failed") && !event.url) {
      const row = db.prepare(
        "SELECT url FROM requests WHERE session_id = ? AND request_id = ?",
      ).get(sessionId, event.requestId);
      if (row?.url) current = { ...event, url: row.url };
    }
    const rawFindings = evaluateEvent(state, current);
    if (current.kind === "net.response" || current.kind === "net.failed") {
      markRequestDone(state, current.requestId);
    }
    const savedFindings = [];
    for (const item of rawFindings) {
      const findingKey = `${sessionId}:${item.rule}:${item.subject}`;
      if (known.has(findingKey)) continue;
      known.add(findingKey);
      db.prepare(`
        INSERT INTO findings (session_id, finding_key, rule, severity, title, detail, subject, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, findingKey, item.rule, item.severity, item.title, item.detail, item.subject, Date.now());
      savedFindings.push(item);
    }

    if (event.kind === "net.request") return { request: upsertRequest(sessionId, event), findings: savedFindings };
    if (event.kind === "net.response" || event.kind === "net.failed") {
      return { request: completeRequest(sessionId, event), findings: savedFindings };
    }
    if (event.kind === "net.body") return { request: saveBody(sessionId, event), findings: savedFindings };
    if (event.kind === "net.ws") return { request: saveFrame(sessionId, event), findings: savedFindings };
    if (event.kind === "store.snapshot") {
      saveSnapshot(sessionId, event);
      return { request: null, findings: savedFindings };
    }
    return { request: null, findings: savedFindings };
  }

  function upsertRequest(sessionId, event) {
    const url = redactUrl(event.url ?? "");
    const headers = JSON.stringify(redactHeaders(event.requestHeaders));
    const body = cap(redactBody(event.postData));
    db.prepare(`
      INSERT INTO requests (
        session_id, request_id, method, url, endpoint, type, request_headers, request_body, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, request_id) DO UPDATE SET
        method = excluded.method,
        url = excluded.url,
        endpoint = excluded.endpoint,
        type = excluded.type,
        request_headers = excluded.request_headers,
        request_body = COALESCE(excluded.request_body, requests.request_body),
        started_at = COALESCE(requests.started_at, excluded.started_at)
    `).run(
      sessionId,
      event.requestId,
      event.method ?? "GET",
      url,
      endpointOf(event.url ?? ""),
      event.type ?? null,
      headers,
      body.text,
      event.startedAt ?? Date.now(),
    );
    return readRequest(sessionId, event.requestId);
  }

  function completeRequest(sessionId, event) {
    const existing = db.prepare(
      "SELECT request_id FROM requests WHERE session_id = ? AND request_id = ?",
    ).get(sessionId, event.requestId);
    if (!existing) {
      upsertRequest(sessionId, {
        requestId: event.requestId,
        method: event.method ?? "GET",
        url: event.url ?? "",
        type: event.type ?? null,
        requestHeaders: [],
        startedAt: event.startedAt ?? Date.now(),
      });
    }
    db.prepare(`
      UPDATE requests SET
        status = ?,
        status_text = ?,
        mime = ?,
        latency_ms = ?,
        size = ?,
        response_headers = ?,
        error = ?,
        url = COALESCE(NULLIF(?, ''), url)
      WHERE session_id = ? AND request_id = ?
    `).run(
      event.status ?? null,
      event.statusText ?? null,
      event.mime ?? null,
      event.latencyMs ?? null,
      event.size ?? null,
      JSON.stringify(redactHeaders(event.responseHeaders)),
      event.error ?? null,
      event.url ? redactUrl(event.url) : "",
      sessionId,
      event.requestId,
    );
    return readRequest(sessionId, event.requestId);
  }

  function saveBody(sessionId, event) {
    const column = event.direction === "request" ? "request_body" : "response_body";
    const body = cap(redactBody(event.text));
    db.prepare(`
      UPDATE requests SET ${column} = ?, truncated = CASE WHEN ? = 1 THEN 1 ELSE truncated END
      WHERE session_id = ? AND request_id = ?
    `).run(body.text, body.truncated ? 1 : 0, sessionId, event.requestId);
    return readRequest(sessionId, event.requestId);
  }

  function saveFrame(sessionId, event) {
    const preview = cap(redactBody(event.preview ?? "")).text ?? "";
    const line = `${event.direction === "sent" ? "→" : "←"} ${preview}`;
    const row = db.prepare(
      "SELECT response_body FROM requests WHERE session_id = ? AND request_id = ?",
    ).get(sessionId, event.requestId);
    const previous = row?.response_body ? `${row.response_body}\n` : "";
    const combined = cap(`${previous}${line}`).text;
    db.prepare(`
      UPDATE requests SET response_body = ?, type = COALESCE(type, 'websocket')
      WHERE session_id = ? AND request_id = ?
    `).run(combined, sessionId, event.requestId);
    return readRequest(sessionId, event.requestId);
  }

  function saveSnapshot(sessionId, event) {
    const localStorage = redactEntries(event.localStorage);
    const sessionStorage = redactEntries(event.sessionStorage);
    const visible = new Set(String(event.jsCookies ?? "").split(";").map((part) => part.trim().split("=")[0]).filter(Boolean));
    const cookies = (event.cookies ?? []).map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain ?? null,
      path: cookie.path ?? null,
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      sameSite: cookie.sameSite || "Missing",
      jsVisible: cookie.httpOnly ? false : visible.has(cookie.name),
      sessionLike: sessionLikeCookie(cookie.name),
      value: proof(cookie.value),
    }));
    db.prepare(`
      INSERT INTO snapshots (session_id, origin, local_storage, session_storage, cookies, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        origin = excluded.origin,
        local_storage = excluded.local_storage,
        session_storage = excluded.session_storage,
        cookies = excluded.cookies,
        updated_at = excluded.updated_at
    `).run(
      sessionId,
      event.origin ?? null,
      JSON.stringify(localStorage),
      JSON.stringify(sessionStorage),
      JSON.stringify(cookies),
      Date.now(),
    );
  }

  function readRequest(sessionId, requestId) {
    const row = db.prepare(
      "SELECT * FROM requests WHERE session_id = ? AND request_id = ?",
    ).get(sessionId, requestId);
    if (!row) return null;
    return {
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
      hasRequestBody: Boolean(row.request_body),
      hasResponseBody: Boolean(row.response_body),
    };
  }

  function listFindings(sessionId) {
    return db.prepare(`
      SELECT id, rule, severity, title, detail, subject, created_at
      FROM findings WHERE session_id = ? ORDER BY id ASC
    `).all(sessionId).map((row) => ({
      id: row.id,
      rule: row.rule,
      severity: row.severity,
      title: row.title,
      detail: row.detail,
      subject: row.subject,
      createdAt: row.created_at,
    }));
  }

  function getSnapshot(sessionId) {
    const row = db.prepare("SELECT * FROM snapshots WHERE session_id = ?").get(sessionId);
    if (!row) return null;
    return {
      origin: row.origin,
      localStorage: JSON.parse(row.local_storage || "[]"),
      sessionStorage: JSON.parse(row.session_storage || "[]"),
      cookies: JSON.parse(row.cookies || "[]"),
      updatedAt: row.updated_at,
    };
  }

  function getSession(sessionId) {
    const row = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM requests r WHERE r.session_id = s.id) AS request_count,
        (SELECT COUNT(*) FROM findings f WHERE f.session_id = s.id) AS finding_count
      FROM sessions s WHERE s.id = ?
    `).get(sessionId);
    if (!row) return null;
    return {
      id: row.id,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      tabUrl: row.tab_url,
      tabTitle: row.tab_title,
      tabId: row.tab_id ?? null,
      score: row.score,
      requestCount: row.request_count,
      findingCount: row.finding_count,
    };
  }

  return { ingest, getSession };
}

function redactEntries(entries) {
  return (entries ?? []).map((entry) => ({
    key: entry.key,
    value: sensitiveEntry(entry) ? proof(entry.value) : String(entry.value ?? ""),
  }));
}

function sensitiveEntry(entry) {
  const value = String(entry.value ?? "");
  if (looksLikeJwt(value)) return true;
  if (/token|secret|password|auth|key|session/i.test(String(entry.key ?? ""))) return true;
  return value.length > 24;
}

function cap(text) {
  if (text == null || text === "") return { text: text ?? null, truncated: false };
  const value = String(text);
  if (value.length <= BODY_CAP) return { text: value, truncated: false };
  return { text: value.slice(0, BODY_CAP), truncated: true };
}
