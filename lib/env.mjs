// Load a gitignored root `.env` into process.env, for side effect. Import this first in any
// service, bot, or CLI entry so a local run picks up RPC and other overrides without exporting
// them by hand.
//
// It never overrides a value that is already set, so a shell export or a Wispbyte panel variable
// always wins over the file. In production, where there is no `.env` on disk and the panel
// supplies everything, this is a no-op. No dependency: a real dotenv would be heavier than the
// few lines this needs.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");

if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // already set: shell / panel wins
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
