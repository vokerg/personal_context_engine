import { startChatGptMcpServer } from "./server.js";

try {
  const server = startChatGptMcpServer();
  const stop = () => server.close();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} catch {
  // Configuration may include sensitive URLs and tokens; fail without printing them.
  console.error("MCP startup failed: missing/unsafe configuration.");
  process.exitCode = 1;
}
