import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:17321",
      "/fixture": "http://127.0.0.1:17321",
      "/live": { target: "ws://127.0.0.1:17321", ws: true },
    },
  },
  build: {
    outDir: path.join(root, "dist"),
    emptyOutDir: true,
  },
});
