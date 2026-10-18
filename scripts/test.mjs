import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const child = spawn(process.execPath, [
  "--disable-warning=ExperimentalWarning",
  "--test",
  "test/inspector.test.mjs",
], { cwd: root, stdio: "inherit" });

child.on("exit", (code) => process.exit(code ?? 1));
