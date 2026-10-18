import { randomUUID } from "node:crypto";

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function demoJwt() {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "demo", role: "user" })}.c2lnbmF0dXJl`;
}

export function buildDemoSession() {
  const id = randomUUID();
  const start = Date.now() - 12 * 60 * 1000;
  const jwt = demoJwt();
  const origin = "https://staging.badbank.test";
  const events = [
    {
      kind: "store.snapshot",
      origin,
      href: `${origin}/accounts`,
      localStorage: [
        { key: "auth_token", value: jwt },
        { key: "theme", value: "dark" },
      ],
      sessionStorage: [],
      jsCookies: "sid=staging-session-9f3a; theme=dark",
      cookies: [
        {
          name: "sid",
          value: "staging-session-9f3a",
          httpOnly: false,
          secure: false,
          sameSite: "None",
          domain: "staging.badbank.test",
          path: "/",
        },
        {
          name: "theme",
          value: "dark",
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
          domain: "staging.badbank.test",
          path: "/",
        },
      ],
    },
  ];

  const profile = [
    { minute: 0, path: "/api/feed", status: 200, latency: 180, size: 42_000 },
    { minute: 0, path: "/api/user", status: 200, latency: 90, size: 1_200 },
    { minute: 2, path: "/api/feed", status: 200, latency: 190, size: 44_000 },
    { minute: 2, path: "/api/quotes", status: 200, latency: 420, size: 80_000 },
    { minute: 4, path: "/api/search", status: 200, latency: 240, size: 1_840_000, duplicate: true, secret: true },
    { minute: 4, path: "/api/quotes", status: 500, latency: 1200, size: 600 },
    { minute: 6, path: "/api/feed", status: 200, latency: 260, size: 51_000 },
    { minute: 6, path: "/api/user", status: 401, latency: 140, size: 180 },
    { minute: 8, path: "/api/quotes", status: 200, latency: 1600, size: 980_000 },
    { minute: 8, path: "/api/feed", status: 502, latency: 510, size: 240 },
    { minute: 10, path: "/api/user", status: 200, latency: 200, size: 1_400 },
    { minute: 10, path: "/auth/refresh", status: 200, latency: 110, size: 900 },
  ];

  events.push(requestEvent("cdn-1", "https://cdn.example.test/assets/app.js", start + 800, jwt, "/assets/app.js"));
  events.push(responseEvent("cdn-1", "https://cdn.example.test/assets/app.js", {
    status: 200,
    latency: 40,
    size: 88_000,
  }, start + 800));

  for (const call of profile) {
    const startedAt = start + call.minute * 60_000 + 1_500;
    pushCall(events, origin, call, startedAt, jwt);
  }

  return {
    session: {
      id,
      url: `${origin}/accounts`,
      title: "BadBank staging",
    },
    events,
  };
}

function pushCall(events, origin, call, startedAt, jwt) {
  const secret = call.secret ? "sk_live_DEMOKEY123456" : null;
  const url = secret
    ? `${origin}${call.path}?api_key=${secret}`
    : `${origin}${call.path}`;
  const firstId = `${call.path}-${call.minute}-a`;
  events.push(requestEvent(firstId, url, startedAt, jwt, call.path));
  if (call.duplicate) {
    events.push(requestEvent(`${call.path}-${call.minute}-b`, url, startedAt + 40, jwt, call.path));
  }
  events.push(responseEvent(firstId, url, call, startedAt));
  if (call.duplicate) {
    events.push(responseEvent(`${call.path}-${call.minute}-b`, url, call, startedAt + 40));
  }
  if (call.path === "/api/user") {
    events.push({
      kind: "net.body",
      requestId: firstId,
      direction: "response",
      text: JSON.stringify({ id: "demo", name: "Demo Owner" }),
    });
  }
}

function requestEvent(requestId, url, startedAt, jwt, path) {
  const headers = [{ name: "accept", value: "application/json" }];
  if (path === "/api/user") headers.push({ name: "authorization", value: `Bearer ${jwt}` });
  return {
    kind: "net.request",
    requestId,
    method: "GET",
    url,
    type: "fetch",
    startedAt,
    requestHeaders: headers,
  };
}

function responseEvent(requestId, url, call, startedAt) {
  return {
    kind: "net.response",
    requestId,
    url,
    status: call.status,
    statusText: call.status >= 400 ? "Error" : "OK",
    mime: "application/json",
    latencyMs: call.latency,
    size: call.size,
    startedAt,
    responseHeaders: [{ name: "content-type", value: "application/json" }],
    error: call.status >= 400 ? `HTTP ${call.status}` : null,
  };
}
