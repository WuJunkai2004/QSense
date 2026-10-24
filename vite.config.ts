import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base=/ui/：由 qqbot-websocket-mcp 在 http://<host>:<port>/ui 托管 dist 产物。
// dev 代理：/ui/api → 本机 MCP 服务（vite dev server 自带 /ui 页面）。
export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ui/api": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 2500,
  },
});
