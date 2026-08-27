import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "ui",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.AI_VIDEO_STUDIO_PORT ?? "4317"}`,
    },
  },
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
  },
});
