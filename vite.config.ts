import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: { proxy: { "/api": "http://127.0.0.1:7867", "/star": "http://127.0.0.1:7867", "/rename": "http://127.0.0.1:7867" } },
  test: { environment: "happy-dom", include: ["tests/**/*.vitest.ts"] },
});
