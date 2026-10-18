import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { buildDemoSession, demoJwt } from "../collector/demo.mjs";
import { buildDossier, forgetLedger } from "../collector/dossier.mjs";
import { createPipeline } from "../collector/pipeline.mjs";
import { looksLikeJwt, redactUrl } from "../collector/redact.mjs";
import { startServer } from "../collector/server.mjs";
import { openStore } from "../collector/store.mjs";

function waitFor(seen, predicate) {
  const existing = seen.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for a live event")), 2000);
    const timerTick = setInterval(() => {
      const match = seen.find(predicate);
      if (!match) return;
      clearInterval(timerTick);
      clearTimeout(timer);
      resolve(match);
    }, 20);
  });
}

test("page ledger survives independently of a later forget", () => {
  const db = openStore(":memory:");
  const pipeline = createPipeline(db);
  const demo = buildDemoSession();
  pipeline.ingest(demo.session, demo.events);
  const dossier = buildDossier(db, "https://staging.badbank.test/accounts");
  assert.equal(dossier.page.domain, "badbank.test");
  assert.equal(dossier.page.path, "/accounts");
  assert.equal(dossier.ledger.visits, 1);
  assert.ok(dossier.ledger.lastSeen);
  assert.equal(dossier.tests.some((item) => item.id === "https" && item.status === "pass"), true);
  assert.equal(dossier.tests.some((item) => item.id === "secret-query" && item.status === "fail"), true);
  const forgotten = forgetLedger(db, "staging.badbank.test");
  assert.equal(forgotten.visits, 1);
  const after = buildDossier(db, "https://staging.badbank.test/accounts");
  assert.equal(after.ledger.visits, 0);
  assert.ok(after.sessions.length >= 1);
});

test("redacts secret query params and recognizes a JWT", () => {
  const raw = "https://app.test/search?api_key=sk_live_DEMOKEY123456&q=wire";
  const redacted = redactUrl(raw);
  assert.equal(redacted.includes("sk_live_DEMOKEY123456"), false);
  assert.equal(new URL(redacted).searchParams.get("q"), "wire");
  assert.equal(looksLikeJwt(demoJwt()), true);
  assert.equal(looksLikeJwt("not-a-token"), false);
});

test("demo session scores the six rules and does not store raw secrets", () => {
  const db = openStore(":memory:");
  const pipeline = createPipeline(db);
  const demo = buildDemoSession();
  const result = pipeline.ingest(demo.session, demo.events);
  const rules = result.findings.map((finding) => finding.rule).sort();
  assert.deepEqual(rules, [
    "cookie-flags",
    "cookie-httponly",
    "duplicate-get",
    "jwt-storage",
    "large-body",
    "secret-query",
  ]);
  assert.equal(result.session.score, 48);

  const dump = JSON.stringify({
    requests: db.prepare("SELECT * FROM requests").all(),
    findings: db.prepare("SELECT * FROM findings").all(),
    snapshots: db.prepare("SELECT * FROM snapshots").all(),
  });
  assert.equal(dump.includes("sk_live_DEMOKEY123456"), false);
  assert.equal(dump.includes(demoJwt()), false);
  assert.equal(dump.includes("staging-session-9f3a"), false);
  db.close();
});

test("http fixture cookies do not raise the HTTPS flag rule", () => {
  const db = openStore(":memory:");
  const pipeline = createPipeline(db);
  const result = pipeline.ingest(
    { id: "11111111-1111-4111-8111-111111111111", url: "http://127.0.0.1:17321/fixture/", title: "BadBank Staging" },
    [{
      kind: "store.snapshot",
      origin: "http://127.0.0.1:17321",
      href: "http://127.0.0.1:17321/fixture/",
      localStorage: [],
      sessionStorage: [],
      jsCookies: "sid=staging-session-9f3a",
      cookies: [{ name: "sid", value: "staging-session-9f3a", httpOnly: false, secure: false, sameSite: "Lax" }],
    }],
  );
  assert.deepEqual(result.findings.map((finding) => finding.rule), ["cookie-httponly"]);
  db.close();
});

test("server demo session exports a redacted HAR", async () => {
  const server = startServer({ port: 0, host: "127.0.0.1", token: "local-dev", dashboardDir: null, fixtureDir: null });
  await server.ready;
  try {
    const created = await fetch(`http://127.0.0.1:${server.port}/api/demo-session`, { method: "POST" });
    assert.equal(created.status, 201);
    const { session } = await created.json();
    const harResponse = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}/har`);
    const har = await harResponse.text();
    assert.equal(har.includes("sk_live_DEMOKEY123456"), false);
    assert.equal(har.includes(demoJwt()), false);
    assert.match(har, /"version": "1.2"/);

    const report = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${session.id}/report.md`);
    const markdown = await report.text();
    assert.match(markdown, /Score: \*\*48\/100\*\*/);
    assert.match(markdown, /Top fixes/);

    const denied = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ingest?token=nope`);
      ws.on("error", () => resolve("closed"));
      ws.on("open", () => reject(new Error("socket accepted a bad token")));
      ws.on("close", () => resolve("closed"));
    });
    assert.equal(denied, "closed");

    const live = new WebSocket(`ws://127.0.0.1:${server.port}/live`);
    const seen = [];
    live.on("message", (buf) => seen.push(JSON.parse(buf.toString())));
    await once(live, "open");
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ingest?token=local-dev`);
    await once(socket, "open");
    socket.send(JSON.stringify({
      type: "batch",
      session: { id: "22222222-2222-4222-8222-222222222222", url: "https://app.test/", title: "Live" },
      events: [{
        kind: "net.request",
        requestId: "r1",
        method: "GET",
        url: "https://app.test/api/search?api_key=sk_live_DEMOKEY123456",
        startedAt: Date.now(),
        requestHeaders: [{ name: "authorization", value: "Bearer secret-value" }],
      }],
    }));
    const forwarded = await waitFor(seen, (message) => message.type === "request" && message.request?.requestId === "r1");
    assert.equal(forwarded.request.url.includes("sk_live_DEMOKEY123456"), false);
    assert.equal(JSON.stringify(forwarded).includes("Bearer secret-value"), false);
    const listed = await fetch(`http://127.0.0.1:${server.port}/api/sessions/22222222-2222-4222-8222-222222222222/requests/r1`);
    const detail = await listed.json();
    assert.equal(detail.request.url.includes("sk_live_DEMOKEY123456"), false);
    assert.equal(detail.request.requestHeaders.some((header) => header.value.includes("secret-value")), false);
    socket.close();
    live.close();
  } finally {
    await server.close();
  }
});
