import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

// Same paths as nginx.conf in production, so the app never needs CORS.
// Host stays the browser's (no changeOrigin): the sync service refuses admin POSTs whose Origin doesn't match it.
const upstream = (target: string, prefix: string): ProxyOptions => ({
  target,
  rewrite: (path) => path.slice(prefix.length),
  // No WWW-Authenticate: a 401 goes to the app's own sign-in screen, not the browser's native prompt.
  configure: (proxy) => proxy.on("proxyRes", (res) => delete res.headers["www-authenticate"]),
});

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/internal": upstream(process.env.INTERNAL_URL ?? "http://localhost:3001", "/api/internal"),
      "/api/sync": upstream(process.env.SYNC_URL ?? "http://localhost:3000", "/api/sync"),
    },
  },
});
