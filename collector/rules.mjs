import {
  cookieNames,
  endpointOf,
  isHttps,
  looksLikeJwt,
  proof,
  secretQueryKeys,
  sessionLikeCookie,
} from "./redact.mjs";

export const WEIGHT = { critical: 15, high: 8, medium: 3 };

export function scoreFromFindings(findings) {
  const penalty = findings.reduce((sum, finding) => sum + (WEIGHT[finding.severity] ?? 0), 0);
  return Math.max(0, 100 - penalty);
}

export function createRuleState() {
  return { recent: [] };
}

function finding(rule, severity, title, detail, subject) {
  return { rule, severity, title, detail, subject };
}

export function evaluateEvent(state, event) {
  switch (event.kind) {
    case "net.request":
      return evaluateRequest(state, event);
    case "net.response":
      return evaluateResponse(event);
    case "store.snapshot":
      return evaluateSnapshot(event);
    default:
      return [];
  }
}

function evaluateRequest(state, event) {
  const findings = [];
  const rawUrl = String(event.url ?? "");
  const method = String(event.method ?? "GET").toUpperCase();
  const startedAt = Number(event.startedAt ?? 0);
  const endpoint = endpointOf(rawUrl);

  for (const key of secretQueryKeys(rawUrl)) {
    findings.push(finding(
      "secret-query",
      "critical",
      "Secret in query string",
      `Parameter "${key}" is on ${method} ${endpoint}. That value lands in history, Referer, and server logs.`,
      `${method} ${endpoint} ${key}`,
    ));
  }

  if (method === "GET") {
    const prior = state.recent.find((row) => {
      return row.method === "GET"
        && row.rawUrl === rawUrl
        && !row.done
        && startedAt - row.startedAt >= 0
        && startedAt - row.startedAt <= 500;
    }) ?? state.recent.find((row) => {
      return row.method === "GET"
        && row.rawUrl === rawUrl
        && Math.abs(startedAt - row.startedAt) <= 500
        && row.requestId !== event.requestId;
    });
    if (prior) {
      findings.push(finding(
        "duplicate-get",
        "medium",
        "Duplicate request",
        `${method} ${endpoint} started again within 500ms. Duplicate client calls are a common source of API cost.`,
        `${method} ${endpoint}`,
      ));
    }
  }

  state.recent.push({
    requestId: event.requestId,
    method,
    rawUrl,
    startedAt,
    done: false,
  });
  if (state.recent.length > 400) state.recent.splice(0, state.recent.length - 400);
  return findings;
}

function evaluateResponse(event) {
  const size = Number(event.size ?? 0);
  if (size <= 1_000_000) return [];
  const endpoint = endpointOf(String(event.url ?? ""));
  const pretty = size >= 1_048_576
    ? `${(size / 1_048_576).toFixed(1)} MB`
    : `${Math.round(size / 1024)} KB`;
  return [finding(
    "large-body",
    "medium",
    "Response larger than 1 MB",
    `${endpoint} returned ${pretty}. Paginate or ask for fewer fields.`,
    endpoint,
  )];
}

function evaluateSnapshot(event) {
  const findings = [];
  const pageUrl = String(event.href ?? event.origin ?? "");
  const https = isHttps(pageUrl);
  const visible = cookieNames(event.jsCookies);

  for (const storeName of ["localStorage", "sessionStorage"]) {
    for (const item of event[storeName] ?? []) {
      if (!looksLikeJwt(item.value)) continue;
      const where = storeName === "localStorage" ? "localStorage" : "sessionStorage";
      findings.push(finding(
        "jwt-storage",
        "critical",
        `JWT in ${where}`,
        `Key "${item.key}" holds a JWT (${proof(item.value)}). Any script on the origin can read the session. Move it to a cookie the page cannot read.`,
        `${where}:${item.key}`,
      ));
    }
  }

  for (const cookie of event.cookies ?? []) {
    const name = String(cookie.name ?? "");
    if (!name || !sessionLikeCookie(name)) continue;
    const jsCanRead = cookie.httpOnly === false || visible.has(name);
    if (jsCanRead && cookie.httpOnly === false) {
      findings.push(finding(
        "cookie-httponly",
        "high",
        "Session cookie readable by JavaScript",
        `Cookie "${name}" is visible to document.cookie. HttpOnly is missing, so any script on the origin can read it.`,
        name,
      ));
    }
    if (!https) continue;
    const missing = [];
    if (cookie.secure === false) missing.push("Secure");
    if (!cookie.sameSite || cookie.sameSite === "None") {
      missing.push(cookie.sameSite === "None" ? "SameSite=None" : "SameSite");
    }
    if (missing.length) {
      findings.push(finding(
        "cookie-flags",
        "high",
        "Cookie missing Secure or SameSite",
        `Cookie "${name}" is missing ${missing.join(" and ")} on an HTTPS app.`,
        `${name}:${missing.join("+")}`,
      ));
    }
  }
  return findings;
}

export function markRequestDone(state, requestId) {
  const row = state.recent.find((item) => item.requestId === requestId);
  if (row) row.done = true;
}
