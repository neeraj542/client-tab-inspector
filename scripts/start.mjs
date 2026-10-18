import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const built = path.join(root, "dashboard", "dist", "index.html");

if (!fs.existsSync(built)) {
  console.log("Building the dashboard…");
  const code = await run(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "dashboard/vite.config.js"]);
  if (code !== 0) process.exit(code ?? 1);
}

const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "collector/index.mjs"], {
  cwd: root,
  stdio: "inherit",
});
server.on("exit", (code) => process.exit(code ?? 0));

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
