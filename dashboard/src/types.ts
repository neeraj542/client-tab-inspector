export type Session = {
  id: string;
  startedAt: number;
  updatedAt: number;
  tabUrl: string | null;
  tabTitle: string | null;
  tabId: number | null;
  score: number;
  requestCount: number;
  findingCount: number;
};

export type Header = { name: string; value: string };

export type RequestMeta = {
  requestId: string;
  method: string | null;
  url: string | null;
  endpoint: string | null;
  type: string | null;
  status: number | null;
  statusText: string | null;
  mime: string | null;
  latencyMs: number | null;
  size: number | null;
  error: string | null;
  startedAt: number | null;
  truncated: boolean;
  hasRequestBody: boolean;
  hasResponseBody: boolean;
};

export type RequestDetail = RequestMeta & {
  requestHeaders: Header[];
  responseHeaders: Header[];
  requestBody: string | null;
  responseBody: string | null;
};

export type Finding = {
  id: number;
  rule: string;
  severity: "critical" | "high" | "medium" | string;
  title: string;
  detail: string;
  subject: string | null;
};

export type StorageItem = { key: string; value: string };

export type CookieItem = {
  name: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
  jsVisible: boolean;
  sessionLike: boolean;
  value: string;
};

export type StorageSnapshot = {
  origin: string | null;
  localStorage: StorageItem[];
  sessionStorage: StorageItem[];
  cookies: CookieItem[];
  updatedAt: number;
};
