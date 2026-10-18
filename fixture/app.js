const token = [
  b64url({ alg: "HS256", typ: "JWT" }),
  b64url({ sub: "demo", role: "user" }),
  "c2lnbmF0dXJl",
].join(".");

localStorage.setItem("auth_token", token);
localStorage.setItem("theme", "dark");
document.cookie = "sid=staging-session-9f3a; path=/; samesite=lax";

const rows = document.querySelector("#rows");
const status = document.querySelector("#status");
document.querySelector("#refresh").addEventListener("click", () => load());
load();

async function load() {
  status.textContent = "Loading activity…";
  const key = "sk_live_DEMOKEY123456";
  const searchUrl = `/fixture/api/search?api_key=${encodeURIComponent(key)}`;
  const [first] = await Promise.all([
    fetch(searchUrl, { cache: "no-store" }),
    fetch(searchUrl, { cache: "no-store" }),
  ]);
  const data = await first.json();
  rows.replaceChildren();
  for (const item of data.items) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    const amount = document.createElement("strong");
    name.textContent = item.name;
    amount.textContent = formatMoney(item.amount);
    li.append(name, amount);
    rows.append(li);
  }
  await fetch("/fixture/api/user", {
    cache: "no-store",
    headers: { Authorization: `Bearer ${localStorage.getItem("auth_token")}` },
  });
  await fetch("/fixture/api/quotes", { cache: "no-store" });
  await fetch("/fixture/api/feed", { cache: "no-store" });
  status.textContent = "Activity updated.";
}

function formatMoney(amount) {
  const sign = amount < 0 ? "−" : "+";
  return `${sign}$${Math.abs(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function b64url(value) {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
