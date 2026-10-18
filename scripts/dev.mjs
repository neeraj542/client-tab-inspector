import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const node = process.execPath;
const children = [
  spawn(node, ["--disable-warning=ExperimentalWarning", "collector/index.mjs"], { cwd: root, stdio: "inherit" }),
  spawn(node, ["node_modules/vite/bin/vite.js", "--config", "dashboard/vite.config.js"], { cwd: root, stdio: "inherit" }),
];

for (const child of children) {
  child.on("exit", (code) => {
    for (const other of children) {
      if (!other.killed) other.kill();
    }
    process.exit(code ?? 0);
  });
}

process.on("SIGINT", () => {
  for (const child of children) child.kill("SIGINT");
});
