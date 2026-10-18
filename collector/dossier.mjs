const HEADER_TESTS = [
  ["content-security-policy", "Content-Security-Policy is present"],
  ["strict-transport-security", "Strict-Transport-Security is present"],
  ["x-content-type-options", "X-Content-Type-Options is present"],
  ["referrer-policy", "Referrer-Policy is present"],
  ["x-frame-options", "X-Frame-Options or frame-ancestors is present"],
];

export function pageParts(raw) {
  const url = new URL(raw);
  const host = url.host;
  return {
    href: `${url.origin}${url.pathname || "/"}`,
    origin: url.origin,
    host,
    domain: registrable(url.hostname),
    path: url.pathname || "/",
    protocol: url.protocol.replace(":", ""),
  };
}

export function rememberVisit(db, session) {
  if (!session?.id || !session.url) return;
  if (db.prepare("SELECT 1 FROM ledger_skip WHERE session_id = ?").get(session.id)) return;
  let parts;
  try {
    parts = pageParts(session.url);
  } catch {
    return;
  }
  db.prepare(`
    INSERT INTO visits (session_id, host, domain, path, url, title, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      title = COALESCE(visits.title, excluded.title)
  `).run(
    session.id,
    parts.host,
    parts.domain,
    parts.path,
    parts.href,
    session.title ?? null,
    session.seenAt ?? Date.now(),
  );
}

export function backfillVisits(db) {
  const rows = db.prepare("SELECT id, tab_url, tab_title, started_at FROM sessions WHERE tab_url IS NOT NULL").all();
  const skipped = db.prepare("SELECT 1 FROM ledger_skip WHERE session_id = ?");
  for (const row of rows) {
    if (skipped.get(row.id)) continue;
    rememberVisit(db, {
      id: row.id,
      url: row.tab_url,
      title: row.tab_title,
      seenAt: row.started_at,
    });
  }
}

export function buildDossier(db, rawUrl) {
  backfillVisits(db);
  const page = pageParts(rawUrl);
  const visits = db.prepare(`
    SELECT * FROM visits
    WHERE host = ? OR domain = ?
    ORDER BY seen_at DESC
    LIMIT 80
  `).all(page.host, page.domain);
  const samePage = visits.filter((row) => row.path === page.path);
  const sessions = listHostSessions(db, page.host);
  const current = sessions[0] ?? null;
  const previous = sessions.find((row) => row.id !== current?.id && samePath(row.tabUrl, page.path)) ?? null;
  const currentEndpoints = current ? endpointsFor(db, current.id) : [];
  const previousEndpoints = previous ? endpointsFor(db, previous.id) : [];
  const document = current ? documentHeaders(db, current.id, page.href) : { headers: [], sawPage: false };
  const headers = document.headers;
  const headerMap = new Map(headers.map((header) => [header.name.toLowerCase(), header.value]));
  const findings = current
    ? db.prepare("SELECT rule FROM findings WHERE session_id = ?").all(current.id).map((row) => row.rule)
    : [];

  return {
    page,
    ledger: {
      visits: samePage.length,
      hostVisits: visits.length,
      firstSeen: stamp(samePage.at(-1)?.seen_at),
      lastSeen: stamp(samePage[0]?.seen_at),
      hostFirstSeen: stamp(visits.at(-1)?.seen_at),
      hostLastSeen: stamp(visits[0]?.seen_at),
      pages: visits.map(mapVisit),
    },
    sessions,
    updates: diffEndpoints(current, previous, currentEndpoints, previousEndpoints),
    headers,
    signals: techSignals(headerMap),
    tests: buildTests({ page, findings, headerMap, current, sawPage: document.sawPage }),
  };
}

export function forgetLedger(db, host) {
  const clean = String(host || "").trim().toLowerCase();
  if (!clean) throw new Error("host required");
  const sessions = db.prepare("SELECT id, tab_url FROM sessions").all();
  const skip = db.prepare("INSERT INTO ledger_skip (session_id) VALUES (?) ON CONFLICT(session_id) DO NOTHING");
  for (const row of sessions) {
    if (sameHost(row.tab_url, clean)) skip.run(row.id);
  }
  const result = db.prepare("DELETE FROM visits WHERE lower(host) = ? OR lower(domain) = ?").run(clean, clean);
  return { visits: result.changes ?? 0 };
}

export function forgetCaptures(db, host) {
  const clean = String(host || "").trim().toLowerCase();
  if (!clean) throw new Error("host required");
  const rows = db.prepare("SELECT id, tab_url FROM sessions").all();
  const ids = rows.filter((row) => sameHost(row.tab_url, clean)).map((row) => row.id);
  const tables = ["requests", "findings", "snapshots", "visits", "sessions"];
  const statements = {
    requests: db.prepare("DELETE FROM requests WHERE session_id = ?"),
    findings: db.prepare("DELETE FROM findings WHERE session_id = ?"),
    snapshots: db.prepare("DELETE FROM snapshots WHERE session_id = ?"),
    visits: db.prepare("DELETE FROM visits WHERE session_id = ?"),
    sessions: db.prepare("DELETE FROM sessions WHERE id = ?"),
  };
  db.exec("BEGIN");
  try {
    for (const id of ids) {
      for (const table of tables) statements[table].run(id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { sessions: ids.length };
}

function listHostSessions(db, host) {
  const rows = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM requests r WHERE r.session_id = s.id) AS request_count,
      (SELECT COUNT(*) FROM findings f WHERE f.session_id = s.id) AS finding_count
    FROM sessions s
    ORDER BY updated_at DESC
    LIMIT 200
  `).all();
  return rows.filter((row) => sameHost(row.tab_url, host)).slice(0, 40).map((row) => ({
    id: row.id,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    tabUrl: row.tab_url,
    tabTitle: row.tab_title,
    tabId: row.tab_id ?? null,
    score: row.score,
    requestCount: row.request_count ?? 0,
    findingCount: row.finding_count ?? 0,
  }));
}

function endpointsFor(db, sessionId) {
  return db.prepare(`
    SELECT method, endpoint, status FROM requests WHERE session_id = ? AND endpoint IS NOT NULL
  `).all(sessionId).map((row) => ({
    key: `${row.method || "GET"} ${row.endpoint}`,
    status: row.status ?? null,
  }));
}

function diffEndpoints(current, previous, currentRows, previousRows) {
  const previousMap = new Map(previousRows.map((row) => [row.key, row.status]));
  const currentMap = new Map(currentRows.map((row) => [row.key, row.status]));
  if (!previous) {
    return {
      previousSessionId: null,
      previousAt: null,
      scoreDelta: null,
      added: [],
      removed: [],
      changed: [],
    };
  }
  const added = [...currentMap.keys()].filter((key) => !previousMap.has(key));
  const removed = [...previousMap.keys()].filter((key) => !currentMap.has(key));
  const changed = [...currentMap.keys()].filter((key) => previousMap.has(key) && previousMap.get(key) !== currentMap.get(key));
  return {
    previousSessionId: previous?.id ?? null,
    previousAt: previous?.startedAt ?? null,
    scoreDelta: current && previous ? current.score - previous.score : null,
    added,
    removed,
    changed,
  };
}

function documentHeaders(db, sessionId, href) {
  const rows = db.prepare(`
    SELECT url, type, response_headers FROM requests
    WHERE session_id = ? AND response_headers IS NOT NULL
    ORDER BY started_at ASC
  `).all(sessionId);
  const match = rows.find((row) => sameDocument(row, href));
  if (!match?.response_headers) return { headers: [], sawPage: false };
  try {
    const parsed = JSON.parse(match.response_headers);
    const headers = Array.isArray(parsed) ? parsed.filter((header) => header?.name) : [];
    return { headers, sawPage: true };
  } catch {
    return { headers: [], sawPage: false };
  }
}

function sameDocument(row, href) {
  if (!row.url) return false;
  let bare = "";
  try {
    const url = new URL(row.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    bare = `${url.origin}${path}`;
  } catch {
    return false;
  }
  const wanted = href.replace(/\/$/, "") || href;
  return bare === wanted;
}

function techSignals(headerMap) {
  const names = ["server", "x-powered-by", "via", "x-served-by", "cf-ray"];
  return names
    .filter((name) => headerMap.has(name))
    .map((name) => ({ name, value: headerMap.get(name) }));
}

function buildTests({ page, findings, headerMap, current, sawPage }) {
  const rules = new Set(findings);
  const tests = [
    {
      id: "https",
      name: "Page is HTTPS",
      status: page.protocol === "https" ? "pass" : "fail",
      detail: page.protocol === "https"
        ? "The page URL uses HTTPS."
        : "The page URL is not HTTPS. Cookies and tokens on this origin can travel in the clear.",
    },
    checkRule("secret-query", "No secret in the query string", rules, "A query parameter looked like a secret. The stored value is redacted."),
    checkRule("duplicate-get", "No duplicate GET inside 500ms", rules, "The same GET started twice inside 500ms."),
    checkRule("cookie-httponly", "Session cookie is not readable by script", rules, "A session-like cookie is visible to JavaScript."),
    checkRule("cookie-flags", "Cookie flags match the page protocol", rules, "A cookie is missing Secure or SameSite on an HTTPS page."),
    checkRule("large-body", "No response above 1 MB", rules, "A response body was larger than 1 MB."),
    checkRule("jwt-storage", "No token-shaped value in web storage", rules, "Web storage holds a value shaped like a JWT. The stored preview is redacted."),
  ];
  if (!current) {
    return tests.map((test) => test.id === "https" ? test : { ...test, status: "unknown", detail: "No capture for this page yet." });
  }
  for (const [name, label] of HEADER_TESTS) {
    const present = name === "x-frame-options"
      ? headerMap.has("x-frame-options") || /frame-ancestors/i.test(headerMap.get("content-security-policy") || "")
      : headerMap.has(name);
    tests.push({
      id: name,
      name: label,
      status: !sawPage ? "unknown" : present ? "pass" : "fail",
      detail: !sawPage
        ? "The page response itself was not in this capture, so this header was not judged."
        : present
          ? "Present on the captured page response."
          : "Absent on the captured page response.",
    });
  }
  return tests;
}

function checkRule(rule, name, rules, failDetail) {
  const failed = rules.has(rule);
  return {
    id: rule,
    name,
    status: failed ? "fail" : "pass",
    detail: failed ? failDetail : "This rule did not fire on the current capture.",
  };
}

function mapVisit(row) {
  return {
    sessionId: row.session_id,
    url: row.url,
    path: row.path,
    title: row.title,
    seenAt: row.seen_at,
    host: row.host,
  };
}

function stamp(value) {
  return value == null ? null : value;
}

function samePath(raw, path) {
  try {
    return new URL(raw).pathname === path;
  } catch {
    return false;
  }
}

function sameHost(raw, host) {
  try {
    return new URL(raw).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function registrable(hostname) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) return hostname;
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}
