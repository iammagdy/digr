import { execFile, execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Validate scratch Postgres target against explicit host allowlist:
 * - target must be "<socket dir or host>:<port>"
 * - host must be a unix-socket dir path (starts with "/") or localhost / 127.0.0.1 / ::1 (lower-cased, trimmed)
 * Throws BEFORE psql is spawned if target is not on the allowlist.
 */
export function assertScratchPgTarget(raw: string): { host: string; port: string } {
  const trimmed = raw.trim();
  const idx = trimmed.lastIndexOf(":");
  if (idx <= 0) {
    throw new Error(`Invalid scratch Postgres target "${trimmed}": must be <host-or-socket-dir>:<port>`);
  }
  const host = trimmed.slice(0, idx).trim();
  const port = trimmed.slice(idx + 1).trim();
  const normalizedHost = host.toLowerCase();

  const isUnixSocket = host.startsWith("/");
  const isLocalHost =
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "::1" ||
    normalizedHost === "[::1]";

  if (!isUnixSocket && !isLocalHost) {
    throw new Error(
      `Refusing non-scratch Postgres host "${host}"! Target must be a unix socket directory or localhost/127.0.0.1/::1.`
    );
  }

  return { host, port };
}

/** DIGR_TEST_PG (or DIGER_TEST_PG) = "<socket dir or host>:<port>" points at a scratch Postgres (never Supabase). Unset = skip. */
export function scratchPgTarget(): { host: string; port: string } | null {
  const raw = process.env.DIGR_TEST_PG || process.env.DIGER_TEST_PG;
  if (!raw) return null;
  return assertScratchPgTarget(raw);
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
