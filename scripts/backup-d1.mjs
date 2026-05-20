import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = join("backups", timestamp);
const output = join(backupDir, "personal_api.sql");

await mkdir(backupDir, { recursive: true });

const child = spawn(
  "npx",
  ["wrangler", "d1", "export", "personal_api", "--remote", "--output", output],
  { stdio: "inherit" }
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
