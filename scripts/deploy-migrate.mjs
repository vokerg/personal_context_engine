import { spawnSync } from "node:child_process";

// Migrations require a direct connection, not a transaction pooler.
// Keep provider connection diagnostics out of hosted logs.
const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Migration failed: configure the server database connection.");
  process.exit(1);
}
const result = spawnSync("npm", ["run", "db:migrate"], {
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: "ignore",
});
if (result.error || result.status !== 0) {
  console.error(
    "Migration failed: check the direct database connection and migration history privately.",
  );
  process.exit(1);
}
console.log("Database migrations checked.");
