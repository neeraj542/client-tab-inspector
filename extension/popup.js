const message = document.querySelector("#message");
const note = document.querySelector("#note");
const tokenInput = document.querySelector("#token");
const pill = document.querySelector("#pill");
const dashboard = document.querySelector("#dashboard");
const tabList = document.querySelector("#tabs");
const modeOne = document.querySelector("#mode-one");
const modeAll = document.querySelector("#mode-all");

init().catch((error) => {
  message.textContent = error.message || String(error);
});

async function init() {
  const status = await chrome.runtime.sendMessage({ type: "status" });
  tokenInput.value = status?.token || "local-dev";
  if (status?.dashboardUrl) dashboard.href = status.dashboardUrl;
  await refresh();
  try {
    const health = await fetch("http://127.0.0.1:17321/api/health");
    if (!health.ok) throw new Error("down");
  } catch {
    message.textContent = "Local app is not running. From client-inspector, run npm start.";
  }
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "status" });
  const mode = status?.watchMode || null;
  const attached = new Set(status?.attachedTabIds || []);
  tokenInput.value = status?.token || tokenInput.value || "local-dev";
  modeOne.classList.toggle("on", mode === "one");
  modeAll.classList.toggle("on", mode === "all");
  pill.textContent = attached.size ? `${attached.size} live` : (mode ? "Ready" : "Choose");
  pill.classList.toggle("on", attached.size > 0);

  tabList.replaceChildren();
  if (!mode) {
    note.textContent = "Choose how this extension watches. The dashboard stays empty until you do.";
    tabList.hidden = true;
    return;
  }

  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const focusedId = windows.find((win) => win.focused)?.id;
  const tabs = [];
  for (const win of windows) {
    for (const tab of win.tabs || []) {
      const url = tab.url || tab.pendingUrl || "";
      if (tab.id == null) continue;
      if (url && /^(chrome|chrome-extension|devtools|edge|about|view-source):/i.test(url)) continue;
      if (isInspector(url)) continue;
      tabs.push({
        tabId: tab.id,
        title: tab.title || url || "Untitled tab",
        url,
        focusedWindow: win.id === focusedId,
        active: Boolean(tab.active && win.id === focusedId),
      });
    }
  }
  tabs.sort((a, b) => Number(b.focusedWindow) - Number(a.focusedWindow) || Number(b.active) - Number(a.active));
  tabList.hidden = false;

  if (mode === "all") {
    note.textContent = "All open tabs. Chrome keeps a debugging banner on each one you watch.";
    const action = document.createElement("button");
    action.type = "button";
    action.className = "wide";
    action.textContent = attached.size ? `Watching ${attached.size}. Watch the open set again` : `Watch ${tabs.length} open tabs`;
    action.addEventListener("click", watchAll);
    tabList.append(action);
  } else {
    note.textContent = "One tab at a time. Click a tab to watch it. Click it again to stop.";
  }

  if (!tabs.length) {
    const empty = document.createElement("p");
    empty.id = "note";
    empty.textContent = "No ordinary web tabs are open.";
    tabList.append(empty);
    return;
  }

  for (const tab of tabs) {
    const button = document.createElement("button");
    button.type = "button";
    const watching = attached.has(tab.tabId);
    button.className = watching ? "on" : "";
    const title = document.createElement("strong");
    title.textContent = `${watching ? "Watching · " : ""}${tab.title}`;
    const url = document.createElement("small");
    url.textContent = tab.url || "Loading…";
    button.append(title, url);
    if (mode === "one") button.addEventListener("click", () => choose(tab.tabId));
    else button.disabled = true;
    tabList.append(button);
  }
}

function isInspector(url) {
  try {
    const parsed = new URL(url);
    return (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") && parsed.port === "17321";
  } catch {
    return false;
  }
}

async function choose(tabId) {
  message.textContent = "Attaching…";
  const status = await chrome.runtime.sendMessage({ type: "inspect", tabId });
  message.textContent = status?.error
    || (status?.attachedTabIds?.includes(tabId) ? "Watching this tab. Leave Chrome's debugging banner up." : "Stopped watching.");
  await refresh();
}

async function watchAll() {
  message.textContent = "Attaching to the open tabs…";
  const status = await chrome.runtime.sendMessage({ type: "watch-all" });
  const count = status?.attachedTabIds?.length || 0;
  message.textContent = status?.error || `Watching ${count} tabs. Each one keeps Chrome's debugging banner.`;
  await refresh();
}

modeOne.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "set-watch-mode", watchMode: "one" });
  message.textContent = "One tab at a time. Pick the tab below.";
  await refresh();
});

modeAll.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "set-watch-mode", watchMode: "all" });
  message.textContent = "All tabs is selected. Confirm below before Chrome attaches.";
  await refresh();
});

tokenInput.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({ type: "set-token", token: tokenInput.value });
});
