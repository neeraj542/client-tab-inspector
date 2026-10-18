const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2 };

export function buildHar(session, requests) {
  return {
    log: {
      version: "1.2",
      creator: { name: "Client Traffic Inspector", version: "0.1.0" },
      comment: "Captured locally from one attached tab. Secret-like headers and query values are redacted.",
      pages: [],
      entries: requests.map((request) => toEntry(request)),
    },
    _session: {
      id: session.id,
      title: session.tabTitle,
      url: session.tabUrl,
    },
  };
}

function toEntry(request) {
  const started = request.startedAt ? new Date(request.startedAt).toISOString() : new Date(0).toISOString();
  const time = request.latencyMs ?? 0;
  return {
    startedDateTime: started,
    time,
    request: {
      method: request.method ?? "GET",
      url: request.url ?? "",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: pairHeaders(request.requestHeaders),
      queryString: queryString(request.url),
      headersSize: -1,
      bodySize: request.requestBody ? request.requestBody.length : 0,
      postData: request.requestBody
        ? { mimeType: "application/json", text: request.requestBody }
        : undefined,
    },
    response: {
      status: request.status ?? 0,
      statusText: request.statusText ?? request.error ?? "",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: pairHeaders(request.responseHeaders),
      content: {
        size: request.size ?? (request.responseBody ? request.responseBody.length : 0),
        mimeType: request.mime ?? "application/octet-stream",
        text: request.responseBody ?? "",
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: request.size ?? -1,
    },
    cache: {},
    timings: { send: 0, wait: time, receive: 0 },
  };
}

function pairHeaders(headers) {
  return (headers ?? []).map((header) => ({ name: header.name, value: header.value }));
}

function queryString(rawUrl) {
  try {
    return [...new URL(rawUrl).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

export function buildReport(session, findings, requests) {
  const ordered = [...findings].sort((a, b) => {
    return (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
  });
  const lines = [
    `# Client audit`,
    ``,
    `Score: **${session.score}/100**`,
    ``,
    `- App: ${session.tabTitle || "Attached tab"}`,
    `- URL: ${session.tabUrl || "unknown"}`,
    `- Requests: ${requests.length}`,
    `- Findings: ${ordered.length}`,
    ``,
    `This report was produced on the laptop that attached to the tab. Header and query secrets are redacted.`,
    ``,
  ];
  if (!ordered.length) {
    lines.push(`## Findings`, ``, `No rules fired for this session.`, ``);
  } else {
    lines.push(`## Findings`, ``);
    for (const finding of ordered) {
      lines.push(`### ${finding.severity.toUpperCase()} — ${finding.title}`, ``, finding.detail, ``);
    }
    lines.push(`## Top fixes`, ``);
    for (const finding of ordered.slice(0, 3)) {
      lines.push(`- ${finding.detail}`);
    }
    lines.push(``);
  }
  const slowest = [...requests]
    .filter((request) => request.latencyMs != null)
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, 3);
  const largest = [...requests]
    .filter((request) => request.size != null)
    .sort((a, b) => b.size - a.size)
    .slice(0, 3);
  if (slowest.length) {
    lines.push(`## Slowest calls`, ``);
    for (const request of slowest) {
      lines.push(`- ${request.method} ${request.endpoint} — ${Math.round(request.latencyMs)} ms`);
    }
    lines.push(``);
  }
  if (largest.length) {
    lines.push(`## Largest payloads`, ``);
    for (const request of largest) {
      lines.push(`- ${request.method} ${request.endpoint} — ${formatBytes(request.size)}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}
