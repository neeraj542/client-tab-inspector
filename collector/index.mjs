import path from "node:path";
import { startServer } from "./server.mjs";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.PORT || 17321);
const token = process.env.INSPECTOR_TOKEN || "local-dev";

const server = startServer({
  port,
  host: "127.0.0.1",
  token,
  dbPath: process.env.INSPECTOR_DB || path.join(root, "data", "inspector.sqlite"),
  dashboardDir: path.join(root, "dashboard", "dist"),
  fixtureDir: path.join(root, "fixture"),
});

await server.ready;
console.log(`Client Traffic Inspector  http://127.0.0.1:${server.port}`);
console.log(`Fixture app               http://127.0.0.1:${server.port}/fixture/`);
console.log(`Pairing token             ${server.token}`);
console.log("Attach the extension to one tab. Traffic stays on this machine.");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
