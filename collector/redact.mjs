const SECRET_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "id_token",
  "refresh_token",
  "api_key",
  "apikey",
  "api-key",
  "key",
  "password",
  "passwd",
  "secret",
  "code",
  "auth",
]);

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;

const SECRET_JSON_KEY = /"(password|secret|private_key|api_key|access_token|authorization)"\s*:\s*"([^"]*)"/gi;

export function proof(value) {
  const text = String(value ?? "");
  if (text.length === 0) return "redacted (0 chars)";
  if (text.length <= 8) return `redacted (${text.length} chars)`;
  return `${text.slice(0, 4)}…${text.slice(-2)} (${text.length} chars)`;
}

export function secretQueryKeys(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return [];
  }
  const found = [];
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) found.push(key);
  }
  return found;
}

export function endpointOf(rawUrl) {
  try {
    return new URL(rawUrl).pathname || "/";
  } catch {
    return String(rawUrl).split("?")[0] || "/";
  }
}

export function redactUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return String(rawUrl);
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.set(key, "redacted");
    }
  }
  return url.toString();
}

export function redactHeaders(headers) {
  return (headers ?? []).map((header) => {
    const name = String(header.name ?? "");
    const value = String(header.value ?? "");
    if (SECRET_HEADER.test(name)) return { name, value: proof(value) };
    return { name, value };
  });
}

export function redactBody(text) {
  if (!text) return text ?? null;
  return String(text).replace(SECRET_JSON_KEY, (_match, key, value) => {
    return `"${key}":"${proof(value)}"`;
  });
}

export function looksLikeJwt(value) {
  const parts = String(value ?? "").split(".");
  if (parts.length !== 3) return false;
  if (parts.some((part) => part.length < 4 || !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const padded = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const header = JSON.parse(json);
    return typeof header?.alg === "string";
  } catch {
    return false;
  }
}

export function isHttps(rawUrl) {
  try {
    return new URL(rawUrl).protocol === "https:";
  } catch {
    return false;
  }
}

export function cookieNames(cookieHeader) {
  const names = new Set();
  if (!cookieHeader) return names;
  for (const part of String(cookieHeader).split(";")) {
    const name = part.trim().split("=")[0];
    if (name) names.add(name);
  }
  return names;
}

export function sessionLikeCookie(name) {
  const value = String(name);
  return /session|token|auth|jwt/i.test(value) || /^sid$/i.test(value);
}
