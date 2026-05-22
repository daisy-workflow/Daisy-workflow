import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import { quasar, transformAssetUrls } from "@quasar/vite-plugin";
import { fileURLToPath } from 'node:url'

// The dev server's proxy target is env-driven so the Playwright test
// stack (API on :3001) and the normal dev stack (API on :3000) can
// share one config:
//
//   • `VITE_API_URL=http://localhost:3001`  → proxy hits the test API
//   • unset                                  → defaults to :3000 (dev)
//
// Same env var the auth-store reads, so the proxy + the in-app
// baseURL stay in sync regardless of which stack is running.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiUrl = env.VITE_API_URL || process.env.VITE_API_URL || "http://localhost:3000";
  // Strip protocol for the ws:// target — the API serves the
  // WebSocket on the same host:port as the HTTP API.
  const wsUrl = apiUrl.replace(/^http/, "ws");

  return {
    plugins: [
      vue({ template: { transformAssetUrls } }),
      quasar({ sassVariables: fileURLToPath(
          new URL('./src/quasar-variables.scss', import.meta.url)
        )}),
    ],
    server: {
      port: 5173,
      proxy: {
        "/api": { target: apiUrl, changeOrigin: true, rewrite: p => p.replace(/^\/api/, "") },
        "/ws":  { target: wsUrl,  ws: true },
      },
    },
  };
});
