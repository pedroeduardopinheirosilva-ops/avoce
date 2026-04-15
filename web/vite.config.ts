import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/trpc": "http://localhost:8470",
      "/api":  "http://localhost:8470",
    },
  },
});
