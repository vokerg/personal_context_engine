import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = [
  "apps/worker/src/chatgpt-mcp/capture.ts",
  "apps/worker/src/chatgpt-mcp/capture.test.ts",
  "apps/worker/src/chatgpt-mcp/github-writer.ts",
  "apps/worker/src/chatgpt-mcp/github-writer.test.ts",
  "apps/worker/src/chatgpt-mcp/oauth.ts",
  "apps/worker/src/chatgpt-mcp/oauth.test.ts",
  "apps/worker/src/chatgpt-mcp/server.ts",
  "apps/worker/src/chatgpt-mcp/server.test.ts",
  "apps/worker/src/chatgpt-mcp/main.ts",
];
execFileSync("./node_modules/.bin/prettier", ["--write", ...files], { stdio: "pipe" });
for (const file of files) {
  console.log("PCE_FORMATTED|" + file + "|" + readFileSync(file).toString("base64"));
}
