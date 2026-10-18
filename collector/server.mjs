import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { buildDossier, forgetCaptures, forgetLedger } from "./dossier.mjs";
import { buildDemoSession } from "./demo.mjs";
import { handleFixture } from "./fixture.mjs";
import { createPipeline } from "./pipeline.mjs";
import { buildHar, buildReport } from "./report.mjs";
import { mapFinding, mapRequest, mapSession, mapSnapshot, openStore } from "./store.mjs";

const SESSION_ID = /^[0-9a-f-]{36}$/i;
const LIST_COLUMNS = `
  request_id, method, url, endpoint, type, status, status_text, mime, latency_ms, size,
  truncated, error, started_at,
  CASE WHEN request_body IS NOT NULL AND length(request_body) > 0 THEN 1 ELSE 0 END AS has_request_body,
  CASE WHEN response_body IS NOT NULL AND length(response_body) > 0 THEN 1 ELSE 0 END AS has_response_body
`;

export function startServer(options) {
  const token = options.token ?? "local-dev";
  const db = openStore(options.dbPath ?? ":memory:");
  const pipeline = createPipeline(db);
  const dashboards = new Set();
  const extensions = new Set();
  let roster = { attachedTabId: null, watchMode: null, tabs: [] };

  function broadcast(message) {
    const payload = JSON.stringify(message);
    for (const socket of dashboards) {
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  function publish(result) {
    if (!result?.session) return;
    broadcast({ type: "session", session: result.session });
    for (const request of result.requests) {
      if (request) broadcast({ type: "request", sessionId: result.session.id, request });
    }
    broadcast({
      type: "audit",
      sessionId: result.session.id,
      score: result.session.score,
      findings: result.findings,
      storage: result.storage,
    });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (handleApi(req, res, url)) return;
      if (options.fixtureDir && handleFixture(req, res, url, options.fixtureDir)) return;
      if (options.dashboardDir) serveDashboard(req, res, url, options.dashboardDir);
      else sendText(res, 404, "Not found");
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/ingest") {
      if (url.searchParams.get("token") !== token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => onIngest(ws));
      return;
    }
    if (url.pathname === "/live") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        dashboards.add(ws);
        ws.on("close", () => dashboards.delete(ws));
        ws.send(JSON.stringify({ type: "hello", ...roster }));
      });
      return;
    }
    socket.destroy();
  });

  function onIngest(ws) {
    extensions.add(ws);
    ws.on("close", () => extensions.delete(ws));
    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message?.type === "tabs") {
        roster = {
          attachedTabId: message.attachedTabId ?? null,
          watchMode: message.watchMode === "one" || message.watchMode === "all" ? message.watchMode : null,
          tabs: Array.isArray(message.tabs) ? message.tabs : [],
        };
        broadcast({ type: "tabs", ...roster });
        return;
      }
      if (message?.type === "watch-error") {
        broadcast({ type: "watch-error", error: message.error, tabId: message.tabId });
        return;
      }
      if (message?.type !== "batch" || !SESSION_ID.test(message.session?.id ?? "")) return;
      try {
        const result = pipeline.ingest(message.session, message.events ?? []);
        publish(result);
      } catch (error) {
        ws.send(JSON.stringify({ type: "error", error: error.message }));
      }
    });
  }

  function handleApi(req, res, url) {
    if (!url.pathname.startsWith("/api/")) return false;
    setCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, version: "0.1.0", tokenRequired: true });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/tabs") {
      sendJson(res, 200, roster);
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/watch") {
      readBody(req).then((body) => {
        const tabId = Number(body.tabId);
        if (!Number.isInteger(tabId)) return sendJson(res, 400, { error: "tabId required" });
        const open = [...extensions].filter((ws) => ws.readyState === 1);
        if (!open.length) {
          return sendJson(res, 409, { error: "Extension is not connected. Reload it in Chrome, then pick a tab again." });
        }
        for (const ws of open) ws.send(JSON.stringify({ type: "watch", tabId }));
        sendJson(res, 202, { ok: true, tabId });
      }).catch(() => sendJson(res, 400, { error: "bad json" }));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/dossier") {
      const target = url.searchParams.get("url") || "";
      try {
        sendJson(res, 200, buildDossier(db, target));
      } catch (error) {
        sendJson(res, 400, { error: error.message || "bad url" });
      }
      return true;
    }
    if (req.method === "DELETE" && url.pathname === "/api/history") {
      const host = url.searchParams.get("host") || "";
      const scope = url.searchParams.get("scope") || "ledger";
      try {
        const result = scope === "captures" ? forgetCaptures(db, host) : forgetLedger(db, host);
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 400, { error: error.message || "could not forget" });
      }
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const rows = db.prepare(`
        SELECT s.*,
          (SELECT COUNT(*) FROM requests r WHERE r.session_id = s.id) AS request_count,
          (SELECT COUNT(*) FROM findings f WHERE f.session_id = s.id) AS finding_count
        FROM sessions s
        ORDER BY updated_at DESC
        LIMIT 200
      `).all();
      sendJson(res, 200, { sessions: rows.map(mapSession) });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/demo-session") {
      const demo = buildDemoSession();
      const result = pipeline.ingest(demo.session, demo.events);
      publish(result);
      sendJson(res, 201, { session: result.session });
      return true;
    }

    const detail = url.pathname.match(/^\/api\/sessions\/([^/]+)\/requests\/([^/]+)$/);
    if (detail && req.method === "GET") {
      const sessionId = decodeURIComponent(detail[1]);
      const requestId = decodeURIComponent(detail[2]);
      if (!SESSION_ID.test(sessionId)) return sendJson(res, 400, { error: "bad session" });
      const row = db.prepare(
        "SELECT * FROM requests WHERE session_id = ? AND request_id = ?",
      ).get(sessionId, requestId);
      if (!row) return sendJson(res, 404, { error: "not found" });
      sendJson(res, 200, { request: mapRequest(row, { includeBodies: true }) });
      return true;
    }

    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/);
    if (!match) return sendJson(res, 404, { error: "not found" });
    const sessionId = decodeURIComponent(match[1]);
    const leaf = match[2] ? decodeURIComponent(match[2]) : "";
    if (!SESSION_ID.test(sessionId)) return sendJson(res, 400, { error: "bad session" });
    const session = readSession(sessionId);
    if (!session) return sendJson(res, 404, { error: "not found" });

    if (!leaf && req.method === "GET") {
      sendJson(res, 200, { session });
      return true;
    }
    if (leaf === "requests" && req.method === "GET") {
      sendJson(res, 200, listRequests(sessionId, url));
      return true;
    }
    if (leaf === "findings" && req.method === "GET") {
      const rows = db.prepare("SELECT * FROM findings WHERE session_id = ? ORDER BY id ASC").all(sessionId);
      sendJson(res, 200, { score: session.score, findings: rows.map(mapFinding) });
      return true;
    }
    if (leaf === "storage" && req.method === "GET") {
      const row = db.prepare("SELECT * FROM snapshots WHERE session_id = ?").get(sessionId);
      sendJson(res, 200, { storage: mapSnapshot(row) });
      return true;
    }
    if (leaf === "har" && req.method === "GET") {
      const requests = db.prepare(
        "SELECT * FROM requests WHERE session_id = ? ORDER BY started_at ASC",
      ).all(sessionId).map((row) => mapRequest(row, { includeBodies: true }));
      const har = buildHar(session, requests);
      const body = JSON.stringify(har, null, 2);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="session-${sessionId.slice(0, 8)}.har"`,
      });
      res.end(body);
      return true;
    }
    if (leaf === "report.md" && req.method === "GET") {
      const findings = db.prepare("SELECT * FROM findings WHERE session_id = ? ORDER BY id ASC").all(sessionId).map(mapFinding);
      const requests = db.prepare(
        `SELECT ${LIST_COLUMNS} FROM requests WHERE session_id = ? ORDER BY started_at ASC`,
      ).all(sessionId).map((row) => mapRequest(row));
      const markdown = buildReport(session, findings, requests);
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${sessionId.slice(0, 8)}.md"`,
      });
      res.end(markdown);
      return true;
    }
    return sendJson(res, 404, { error: "not found" });
  }

  function readSession(sessionId) {
    const row = db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM requests r WHERE r.session_id = s.id) AS request_count,
        (SELECT COUNT(*) FROM findings f WHERE f.session_id = s.id) AS finding_count
      FROM sessions s WHERE s.id = ?
    `).get(sessionId);
    return mapSession(row);
  }

  function listRequests(sessionId, url) {
    const q = url.searchParams.get("q")?.trim() ?? "";
    const where = ["session_id = ?"];
    const params = [sessionId];
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      where.push(`(
        url LIKE ? ESCAPE '\\'
        OR endpoint LIKE ? ESCAPE '\\'
        OR IFNULL(request_body, '') LIKE ? ESCAPE '\\'
        OR IFNULL(response_body, '') LIKE ? ESCAPE '\\'
      )`);
      params.push(like, like, like, like);
    }
    const total = db.prepare(`SELECT COUNT(*) AS count FROM requests WHERE ${where.join(" AND ")}`).get(...params).count;
    const rows = db.prepare(`
      SELECT ${LIST_COLUMNS}
      FROM requests
      WHERE ${where.join(" AND ")}
      ORDER BY started_at ASC
      LIMIT 5000
    `).all(...params);
    return { requests: rows.map((row) => mapRequest(row)), total };
  }

  const ready = new Promise((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
  });

  const address = () => server.address();
  return {
    token,
    ready,
    get port() {
      const info = address();
      return info && typeof info === "object" ? info.port : options.port;
    },
    async close() {
      for (const socket of dashboards) socket.close();
      wss.close();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      db.close();
    },
  };
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("vary", "origin");
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString() || "{}";
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
  return true;
}

function resolveInside(root, requestPath) {
  const base = path.resolve(root);
  const target = path.resolve(base, requestPath);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

function sendText(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function serveDashboard(req, res, url, dashboardDir) {
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const filePath = resolveInside(dashboardDir, requested);
  if (!filePath) return sendText(res, 403, "Forbidden");
  const target = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(dashboardDir, "index.html");
  if (!fs.existsSync(target)) {
    sendText(res, 503, "Dashboard is not built yet. Run npm start from client-inspector.");
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".map": "application/json",
  };
  res.writeHead(200, {
    "content-type": types[path.extname(target)] || "application/octet-stream",
    "cache-control": path.extname(target) === ".html" ? "no-store" : "public, max-age=3600",
  });
  fs.createReadStream(target).pipe(res);
}
