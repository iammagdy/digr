import { execFile, execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** DIGR_TEST_PG="<socket dir or host>:<port>" points at a scratch Postgres (never Supabase). Unset = skip. */
export function scratchPgTarget(): { host: string; port: string } | null {
  const raw = process.env.DIGR_TEST_PG;
  if (!raw) return null;
  const idx = raw.lastIndexOf(":");
  return { host: raw.slice(0, idx), port: raw.slice(idx + 1) };
}

export interface ScratchDb {
  sql: (statement: string) => string;
  sqlAsync: (statement: string) => Promise<string>;
  drop: () => void;
}

const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");
const STUBS = path.resolve(__dirname, "supabase-stubs.sql");

/** Fresh database: Supabase role/auth stubs, then every repo migration in order (Supabase-only ones may fail). */
export function createScratchDb(): ScratchDb {
  const target = scratchPgTarget()!;
  const name = `digr_t_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const base = ["-h", target.host, "-p", target.port, "-U", "postgres", "-X", "-q"];
  execFileSync("psql", [...base, "-d", "postgres", "-c", `create database ${name}`]);
  const run = (args: string[]) =>
    execFileSync("psql", [...base, "-d", name, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run(["-v", "ON_ERROR_STOP=1", "-f", STUBS]);
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      run(["-v", "ON_ERROR_STOP=1", "-f", path.join(MIGRATIONS, file)]);
    } catch {
      // Migrations that need Supabase-only objects (pg_net, storage helpers) are irrelevant to the money schema.
    }
  }
  run(["-c", "GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role"]);
  const args = (statement: string) => [...base, "-d", name, "-At", "-c", statement];
  return {
    sql: (statement) => execFileSync("psql", args(statement), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
    sqlAsync: async (statement) => (await execFileAsync("psql", args(statement), { encoding: "utf8" })).stdout.trim(),
    drop: () => {
      try { execFileSync("psql", [...base, "-d", "postgres", "-c", `drop database if exists ${name} with (force)`]); } catch { /* best effort */ }
    },
  };
}
