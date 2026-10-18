window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.source !== "cti-page" || typeof data.id !== "number") return;
  if (data.type !== "tabs" && data.type !== "inspect" && data.type !== "page-memory") return;
  chrome.runtime.sendMessage({ type: data.type, tabId: data.tabId, url: data.url }, (response) => {
    const error = chrome.runtime.lastError?.message || "";
    window.postMessage({
      source: "cti-ext",
      id: data.id,
      response: response || null,
      error,
    }, location.origin);
  });
});
