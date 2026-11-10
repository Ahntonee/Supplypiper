import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin in development so the session cookie and CSRF origin check behave like production.
    proxy: { "/api": { target: "http://127.0.0.1:4000", changeOrigin: false } },
    fs: { allow: ["../.."] },
  },
  build: { sourcemap: true },
});
