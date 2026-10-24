import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repositoryRoot, "");
  const port = Number(env.PCE_WEB_PORT ?? "4200");
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("PCE_WEB_PORT must be a valid TCP port");
  const sessionAuth = ["single-user", "dev-single-user"].includes(
    env.PCE_AUTH_MODE ?? "",
  );
  const dbSearch = env.PCE_DB_SEARCH === "true";
  return {
    envDir: repositoryRoot,
    define: {
      "import.meta.env.VITE_API_BASE_URL": JSON.stringify(
        env.VITE_API_BASE_URL ?? `http://127.0.0.1:${env.API_PORT ?? "3000"}`,
      ),
      "import.meta.env.VITE_PCE_DB_SEARCH": JSON.stringify(String(dbSearch)),
      "import.meta.env.VITE_PCE_LOCAL_BROWSE": JSON.stringify(
        String(dbSearch || env.PCE_LOCAL_BROWSE === "true"),
      ),
      "import.meta.env.VITE_PCE_RESEARCH_REPORTS": JSON.stringify(
        String(env.PCE_RESEARCH_REPORTS === "true"),
      ),
      "import.meta.env.VITE_PCE_SESSION_AUTH": JSON.stringify(
        String(sessionAuth),
      ),
    },
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port,
      strictPort: true,
    },
  };
});
