import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = process.env.PORT ?? env.PORT ?? "8787";
  return {
    plugins: [react()],
    server: {
      port: 3000,
      proxy: { "/api": `http://localhost:${apiPort}` },
    },
  };
});
