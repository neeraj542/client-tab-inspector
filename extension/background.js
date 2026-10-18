const COLLECTOR_HTTP = "http://127.0.0.1:17321";
const COLLECTOR_WS = "ws://127.0.0.1:17321/ingest";
const DEFAULT_TOKEN = "local-dev";
const BODY_CAP = 64 * 1024;
const BUFFER_MAX = 2000;

let token = DEFAULT_TOKEN;
let socket = null;
let flushTimer = null;
let dropBodies = false;
let watchMode = null;
let attachedTabId = null;
let snapshotTimer = null;
let tabPushTimer = null;
const clients = new Map();
const sessionsByTab = new Map();

chrome.storage.local.get(["token", "watchMode"], (stored) => {
  if (stored.token) token = stored.token;
  if (stored.watchMode === "one" || stored.watchMode === "all") watchMode = stored.watchMode;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "status") {
    sendResponse(status());
    return false;
  }
  if (message.type === "set-token") {
    token = (message.token || DEFAULT_TOKEN).trim() || DEFAULT_TOKEN;
    chrome.storage.local.set({ token });
    reconnect();
    sendResponse(status());
    return false;
  }
  if (message.type === "tabs") {
    listWindowTabs().then((tabs) => sendResponse({
      watchMode,
      attachedTabId,
      tabs: tabs.filter((tab) => clients.has(tab.tabId)),
    })).catch((error) => {
      sendResponse({ tabs: [], attachedTabId, watchMode, error: error.message });
    });
    return true;
  }
  if (message.type === "set-watch-mode") {
    setWatchMode(message.watchMode)
      .then(() => sendResponse(status()))
      .catch((error) => sendResponse({ ...status(), error: error.message || String(error) }));
    return true;
  }
  if (message.type === "watch-all") {
    watchAll()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ...status(), error: error.message || String(error) }));
    return true;
  }
  if (message.type === "page-memory") {
    pageMemory(message.url).then(sendResponse).catch((error) => {
      sendResponse({ available: false, error: error.message || String(error) });
    });
    return true;
  }
  if (message.type === "inspect") {
    inspect(message.tabId, "toggle")
      .then(() => sendResponse(status()))
      .catch((error) => sendResponse({ ...status(), error: error.message || String(error) }));
    return true;
  }
  return false;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId || !clients.has(source.tabId)) return;
  handleDebugEvent(source.tabId, method, params);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId && clients.has(source.tabId)) detach(source.tabId).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sessionsByTab.delete(tabId);
  if (clients.has(tabId)) detach(tabId).catch(() => {});
  else scheduleTabs();
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (watchMode === "all" && info.status === "complete" && !clients.has(tabId)) {
    inspect(tabId, "watch").catch(() => {});
  }
  scheduleTabs();
});
chrome.tabs.onActivated.addListener(() => scheduleTabs());

connectSocket();
resumeAttachment().catch(() => {});

async function setWatchMode(mode) {
  const next = mode === "one" || mode === "all" ? mode : null;
  watchMode = next;
  await chrome.storage.local.set({ watchMode: next });
  if (next !== "all") {
    for (const tabId of [...clients.keys()]) await detach(tabId);
  }
  scheduleTabs();
}

async function watchAll() {
  if (watchMode !== "all") throw new Error("Choose all tabs in the extension before watching every tab.");
  const tabs = await listWindowTabs();
  const errors = [];
  for (const tab of tabs) {
    try {
      await inspect(tab.tabId, "watch");
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }
  scheduleTabs();
  return { ...status(), errors };
}

async function inspect(tabId, mode) {
  if (!watchMode) throw new Error("Open the extension and choose one tab, or all tabs.");
  if (mode === "toggle" && clients.has(tabId) && (watchMode === "one" || clients.size === 1)) {
    await detach(tabId);
    scheduleTabs();
    return;
  }
  if (clients.has(tabId)) {
    attachedTabId = tabId;
    scheduleTabs();
    return;
  }
  if (watchMode === "one") {
    for (const id of [...clients.keys()]) await detach(id);
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error("That tab is no longer open.");
  }
  if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("devtools://") || isInspectorPage(tab.url)) {
    throw new Error("Chrome does not allow attaching to this page. Pick another tab.");
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    throw new Error(`Could not attach. Close DevTools on this tab and click Inspect again. ${error.message || ""}`.trim());
  }
  await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
    maxTotalBufferSize: 10_000_000,
    maxResourceBufferSize: 1_000_000,
    maxPostDataSize: BODY_CAP,
  });
  await chrome.debugger.sendCommand({ tabId }, "Page.enable");
  const sessionId = sessionsByTab.get(tabId) || await existingSession(tabId) || crypto.randomUUID();
  sessionsByTab.set(tabId, sessionId);
  clients.set(tabId, {
    sessionId,
    url: tab.url,
    title: tab.title || "",
    requests: new Map(),
    queue: [],
  });
  attachedTabId = tabId;
  await chrome.action.setBadgeBackgroundColor({ color: "#c4554d" });
  await chrome.action.setBadgeText({ tabId, text: "ON" });
  await persistAttachment();
  connectSocket();
  enqueue(tabId, { kind: "session.start" });
  snapshot(tabId).catch(() => {});
  if (snapshotTimer) clearInterval(snapshotTimer);
  snapshotTimer = setInterval(() => {
    for (const id of clients.keys()) snapshot(id).catch(() => {});
  }, 3000);
  scheduleTabs();
}

async function detach(tabId) {
  const client = clients.get(tabId);
  clients.delete(tabId);
  if (attachedTabId === tabId) attachedTabId = clients.keys().next().value ?? null;
  if (!clients.size && snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
  chrome.action.setBadgeText({ tabId, text: "" });
  if (client) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      /* already detached */
    }
  }
  await persistAttachment();
  scheduleTabs();
}

async function persistAttachment() {
  const focus = attachedTabId != null ? clients.get(attachedTabId) : null;
  await chrome.storage.session.set({
    attach: focus ? { tabId: attachedTabId, sessionId: focus.sessionId, url: focus.url, title: focus.title } : null,
  });
}

async function resumeAttachment() {
  const stored = await chrome.storage.session.get("attach");
  const attach = stored.attach;
  if (!attach?.tabId || !attach.sessionId) return;
  const targets = await chrome.debugger.getTargets();
  const still = targets.some((target) => target.tabId === attach.tabId && target.attached);
  if (!still) {
    await chrome.storage.session.remove("attach");
    return;
  }
  attachedTabId = attach.tabId;
  sessionsByTab.set(attach.tabId, attach.sessionId);
  clients.set(attach.tabId, {
    sessionId: attach.sessionId,
    url: attach.url || "",
    title: attach.title || "",
    requests: new Map(),
    queue: [],
  });
  await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Network.enable", {
    maxPostDataSize: BODY_CAP,
  }).catch(() => {});
  await chrome.debugger.sendCommand({ tabId: attachedTabId }, "Page.enable").catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: "#c4554d" });
  await chrome.action.setBadgeText({ tabId: attachedTabId, text: "ON" });
  connectSocket();
  if (snapshotTimer) clearInterval(snapshotTimer);
  snapshotTimer = setInterval(() => {
    for (const id of clients.keys()) snapshot(id).catch(() => {});
  }, 3000);
}

function connectSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  socket = new WebSocket(`${COLLECTOR_WS}?token=${encodeURIComponent(token)}`);
  socket.onopen = () => {
    flush();
    scheduleTabs();
  };
  socket.onclose = () => {
    socket = null;
    setTimeout(connectSocket, 1000);
  };
  socket.onerror = () => {};
  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    dropBodies = Boolean(message.dropBodies);
    if (message.type === "watch" && Number.isInteger(message.tabId)) {
      inspect(message.tabId, "watch")
        .then(() => scheduleTabs())
        .catch((error) => {
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "watch-error", tabId: message.tabId, error: error.message }));
          }
        });
    }
  };
}

function scheduleTabs() {
  if (tabPushTimer) clearTimeout(tabPushTimer);
  tabPushTimer = setTimeout(() => pushTabs().catch(() => {}), 200);
}

async function existingSession(tabId) {
  try {
    const response = await fetch(`${COLLECTOR_HTTP}/api/sessions`);
    if (!response.ok) return null;
    const body = await response.json();
    const match = (body.sessions || []).find((row) => row.tabId === tabId);
    return match?.id || null;
  } catch {
    return null;
  }
}

async function pageMemory(rawUrl) {
  if (!rawUrl) return { available: false };
  let host = "";
  try {
    host = new URL(rawUrl).host;
  } catch {
    return { available: false };
  }
  const hits = await chrome.history.search({ text: host, startTime: 0, maxResults: 100 });
  const related = [];
  for (const item of hits) {
    try {
      if (new URL(item.url).host !== host) continue;
    } catch {
      continue;
    }
    related.push({
      url: item.url,
      title: item.title || "",
      lastVisitTime: item.lastVisitTime || null,
      visitCount: item.visitCount || 0,
    });
  }
  const lastVisitTime = related.reduce((max, item) => Math.max(max, item.lastVisitTime || 0), 0);
  return {
    available: true,
    host,
    lastVisitTime: lastVisitTime || null,
    visitCount: related.reduce((sum, item) => sum + item.visitCount, 0),
    pages: related.slice(0, 15),
  };
}

async function listWindowTabs() {
  let windows = [];
  try {
    windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  } catch {
    const tabs = await chrome.tabs.query({});
    windows = [{ id: 0, focused: true, tabs }];
  }
  const focusedId = windows.find((win) => win.focused)?.id ?? windows[0]?.id;
  const listed = [];
  for (const win of windows) {
    for (const tab of win.tabs || []) {
      if (!watchableTab(tab)) continue;
      const url = tab.url || tab.pendingUrl || "";
      listed.push({
        tabId: tab.id,
        title: tab.title || url || "Untitled tab",
        url,
        favIconUrl: typeof tab.favIconUrl === "string" && /^https?:/i.test(tab.favIconUrl) ? tab.favIconUrl : "",
        active: Boolean(tab.active && win.id === focusedId),
        attached: clients.has(tab.id),
        focusedWindow: win.id === focusedId,
      });
    }
  }
  listed.sort((a, b) => Number(b.focusedWindow) - Number(a.focusedWindow) || Number(b.active) - Number(a.active));
  return listed;
}

function watchableTab(tab) {
  if (tab.id == null) return false;
  const url = tab.url || tab.pendingUrl || "";
  if (!url) return true;
  return !/^(chrome|chrome-extension|devtools|edge|about|view-source):/i.test(url);
}

async function pushTabs() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const tabs = (await listWindowTabs()).filter((tab) => clients.has(tab.tabId));
  socket.send(JSON.stringify({ type: "tabs", watchMode, attachedTabId, tabs }));
}

function reconnect() {
  if (socket) socket.close();
  socket = null;
  connectSocket();
}

function enqueue(tabId, event) {
  const client = clients.get(tabId);
  if (!client) return;
  if (dropBodies && (event.kind === "net.body" || event.kind === "net.ws")) return;
  client.queue.push(event);
  if (client.queue.length > BUFFER_MAX) {
    client.queue = client.queue.filter((item) => item.kind !== "net.body" && item.kind !== "net.ws").slice(-BUFFER_MAX);
  }
  const waiting = [...clients.values()].reduce((sum, item) => sum + item.queue.length, 0);
  if (waiting >= 50) flush();
  else if (!flushTimer) flushTimer = setTimeout(flush, 100);
}

function flush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 2_000_000) dropBodies = true;
  let pending = false;
  for (const [tabId, client] of clients) {
    if (dropBodies) client.queue = client.queue.filter((item) => item.kind !== "net.body" && item.kind !== "net.ws");
    if (!client.queue.length) continue;
    const events = client.queue.splice(0, 50);
    socket.send(JSON.stringify({
      type: "batch",
      session: { id: client.sessionId, tabId, url: client.url, title: client.title },
      events,
    }));
    if (client.queue.length) pending = true;
  }
  if (pending) flushTimer = setTimeout(flush, 100);
}

function handleDebugEvent(tabId, method, params) {
  const client = clients.get(tabId);
  if (!client) return;
  const requests = client.requests;
  if (method === "Network.requestWillBeSent") {
    const request = params.request || {};
    const url = request.url || "";
    if (!isPageUrl(url)) return;
    const startedAt = Math.round((params.wallTime || Date.now() / 1000) * 1000);
    requests.set(params.requestId, {
      method: request.method || "GET",
      url,
      type: (params.type || "other").toLowerCase(),
      startedAt,
      timestamp: params.timestamp,
    });
    enqueue(tabId, {
      kind: "net.request",
      requestId: params.requestId,
      method: request.method || "GET",
      url,
      type: (params.type || "other").toLowerCase(),
      startedAt,
      requestHeaders: headersToArray(request.headers),
      postData: capText(request.postData),
    });
    return;
  }
  if (method === "Network.responseReceived") {
    const known = requests.get(params.requestId);
    if (!known) return;
    known.status = params.response?.status ?? 0;
    known.statusText = params.response?.statusText ?? "";
    known.mime = params.response?.mimeType ?? "";
    known.responseHeaders = headersToArray(params.response?.headers);
    known.encodedLength = params.response?.encodedDataLength ?? null;
    return;
  }
  if (method === "Network.loadingFinished") {
    finishRequest(tabId, params.requestId, params).catch(() => {});
    return;
  }
  if (method === "Network.loadingFailed") {
    const known = requests.get(params.requestId);
    if (!known) return;
    const latencyMs = elapsed(known, params.timestamp);
    enqueue(tabId, {
      kind: "net.response",
      requestId: params.requestId,
      url: known.url,
      method: known.method,
      status: known.status ?? 0,
      statusText: known.statusText ?? "",
      mime: known.mime ?? "",
      latencyMs,
      size: known.encodedLength ?? 0,
      responseHeaders: known.responseHeaders ?? [],
      error: params.errorText || "failed",
      startedAt: known.startedAt,
    });
    requests.delete(params.requestId);
    return;
  }
  if (method === "Network.webSocketCreated") {
    requests.set(params.requestId, {
      method: "WS",
      url: params.url,
      type: "websocket",
      startedAt: Date.now(),
      timestamp: null,
    });
    enqueue(tabId, {
      kind: "net.request",
      requestId: params.requestId,
      method: "WS",
      url: params.url,
      type: "websocket",
      startedAt: Date.now(),
      requestHeaders: [],
    });
    return;
  }
  if (method === "Network.webSocketFrameSent" || method === "Network.webSocketFrameReceived") {
    const payload = params.response?.payloadData || "";
    enqueue(tabId, {
      kind: "net.ws",
      requestId: params.requestId,
      direction: method === "Network.webSocketFrameSent" ? "sent" : "received",
      size: payload.length,
      preview: capText(payload),
    });
    return;
  }
  if (method === "Page.frameNavigated" && !params.frame?.parentId) {
    client.url = params.frame?.url || client.url;
    persistAttachment();
    setTimeout(() => snapshot(tabId).catch(() => {}), 600);
  }
}

async function finishRequest(tabId, requestId, params) {
  const client = clients.get(tabId);
  if (!client) return;
  const known = client.requests.get(requestId);
  if (!known) return;
  const size = params.encodedDataLength ?? known.encodedLength ?? 0;
  const latencyMs = elapsed(known, params.timestamp);
  enqueue(tabId, {
    kind: "net.response",
    requestId,
    url: known.url,
    method: known.method,
    status: known.status ?? 0,
    statusText: known.statusText ?? "",
    mime: known.mime ?? "",
    latencyMs,
    size,
    responseHeaders: known.responseHeaders ?? [],
    startedAt: known.startedAt,
  });
  if (wantsBody(known.mime, size) && !dropBodies) {
    try {
      const body = await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId });
      const text = body.base64Encoded ? decodeBase64(body.body) : body.body;
      if (text) {
        enqueue(tabId, {
          kind: "net.body",
          requestId,
          direction: "response",
          truncated: text.length > BODY_CAP,
          text: text.slice(0, BODY_CAP),
          size: text.length,
        });
      }
    } catch {
      /* body already evicted */
    }
  }
  client.requests.delete(requestId);
}

async function snapshot(tabId) {
  const client = clients.get(tabId);
  if (!client) return;
  const evaluated = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression: `(() => {
      const dump = (storage) => {
        const out = [];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          out.push({ key, value: String(storage.getItem(key) ?? "").slice(0, 4096) });
        }
        return out;
      };
      return JSON.stringify({
        origin: location.origin,
        href: location.href,
        localStorage: dump(localStorage),
        sessionStorage: dump(sessionStorage),
        jsCookies: document.cookie
      });
    })()`,
    returnByValue: true,
  });
  if (!evaluated?.result?.value) return;
  const page = JSON.parse(evaluated.result.value);
  client.url = page.href || client.url;
  let cookies = [];
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, "Network.getCookies", { urls: [page.href] });
    cookies = (result.cookies || []).map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }));
  } catch {
    cookies = [];
  }
  enqueue(tabId, {
    kind: "store.snapshot",
    origin: page.origin,
    href: page.href,
    localStorage: page.localStorage,
    sessionStorage: page.sessionStorage,
    jsCookies: page.jsCookies,
    cookies,
  });
}

function wantsBody(mime, size) {
  if (!mime || size > BODY_CAP) return false;
  if (/image|font|audio|video|wasm|octet-stream/i.test(mime)) return false;
  return /json|text|xml|javascript|x-www-form-urlencoded|graphql/i.test(mime);
}

function isInspectorPage(url) {
  try {
    const parsed = new URL(url);
    return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port === "17321";
  } catch {
    return false;
  }
}

function isPageUrl(url) {
  return /^https?:/i.test(url) || url.startsWith("ws://") || url.startsWith("wss://");
}

function elapsed(known, timestamp) {
  if (known.timestamp == null || timestamp == null) return null;
  return Math.max(0, Math.round((timestamp - known.timestamp) * 1000));
}

function headersToArray(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers.map((header) => ({ name: header.name, value: String(header.value ?? "") }));
  }
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

function capText(value) {
  if (value == null) return null;
  const text = String(value);
  return text.length > BODY_CAP ? text.slice(0, BODY_CAP) : text;
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function status() {
  const focus = attachedTabId != null ? clients.get(attachedTabId) : null;
  return {
    watchMode,
    attachedTabId,
    attachedTabIds: [...clients.keys()],
    sessionId: focus?.sessionId ?? null,
    connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
    token,
    dashboardUrl: COLLECTOR_HTTP,
    error: null,
  };
}
