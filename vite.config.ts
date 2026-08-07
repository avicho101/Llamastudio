import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  // Tauri expects a fixed port and to read the built assets from outDir
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    outDir: "dist",
    target: "es2021",
    rollupOptions: {
      input: {
        main: "index.html",
        splash: "splash.html",
      },
    },
  },
});
