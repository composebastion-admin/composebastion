import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "../../package.json";

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version)
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        ws: true
      }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
});
