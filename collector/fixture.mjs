import fs from "node:fs";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function handleFixture(req, res, url, fixtureDir) {
  if (url.pathname === "/fixture") {
    redirect(res, "/fixture/");
    return true;
  }
  if (!url.pathname.startsWith("/fixture/")) return false;

  if (url.pathname === "/fixture/api/search") return json(res, searchBody());
  if (url.pathname === "/fixture/api/user") return json(res, { id: "demo", name: "Demo Owner", plan: "staging" });
  if (url.pathname === "/fixture/api/feed") {
    return json(res, {
      items: [
        { id: "n1", text: "Wire received" },
        { id: "n2", text: "Card ending 4412 charged" },
      ],
    });
  }
  if (url.pathname === "/fixture/api/quotes") {
    setTimeout(() => {
      json(res, { quotes: [{ pair: "USD/EUR", px: 0.92 }, { pair: "USD/INR", px: 83.4 }] });
    }, 1100);
    return true;
  }

  const relative = decodeURIComponent(url.pathname.slice("/fixture/".length)) || "index.html";
  const filePath = resolveInside(fixtureDir, relative);
  if (!filePath) {
    send(res, 403, "Forbidden");
    return true;
  }
  const target = fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()
    ? path.join(filePath, "index.html")
    : filePath;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    send(res, 404, "Not found");
    return true;
  }
  const body = fs.readFileSync(target);
  res.writeHead(200, {
    "content-type": TYPES[path.extname(target)] || "application/octet-stream",
    "cache-control": "no-store",
    "set-cookie": "sid=staging-session-9f3a; Path=/; SameSite=Lax",
  });
  res.end(body);
  return true;
}

function searchBody() {
  return {
    items: [
      { id: "TX-1044", name: "Northwind Supplies", amount: -1200.4 },
      { id: "TX-1045", name: "Payroll", amount: -8420 },
      { id: "TX-1046", name: "Incoming wire", amount: 15000 },
      { id: "TX-1047", name: "Cloud invoice", amount: -640.22 },
    ],
    padding: "x".repeat(1_050_000),
  };
}

function json(res, body) {
  const payload = JSON.stringify(body);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
  return true;
}

function send(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function resolveInside(root, requestPath) {
  const base = path.resolve(root);
  const target = path.resolve(base, requestPath);
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}
