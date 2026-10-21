import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, chownSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";

/**
 * A throw-away local PostgreSQL (the real server, not a stand-in) holding the REAL money schema and the REAL function bodies of
 * production, read with SELECT only on 2026-10-21 and saved under docs/proposals/prod-definitions/. Nothing connects to Supabase.
 * `replicaAvailable()` is false when no local PostgreSQL server binary exists; the tests that need it say so and are skipped
 * visibly (they run in the development container and on any machine with PostgreSQL installed).
 */
const ROOT = path.resolve(__dirname, "..", "..");
export const DEFINITIONS_DIR = path.join(ROOT, "docs", "proposals", "prod-definitions");
const REPLICA_DIR = path.join(ROOT, "tests", "replica");

export function postgresBinDir(): string | null {
  const base = "/usr/lib/postgresql";
  if (!existsSync(base)) return process.env.REPLICA_PG_BIN && existsSync(path.join(process.env.REPLICA_PG_BIN, "initdb")) ? process.env.REPLICA_PG_BIN : null;
  const versions = readdirSync(base).sort((a, b) => Number(b) - Number(a));
  for (const v of versions) if (existsSync(path.join(base, v, "bin", "initdb"))) return path.join(base, v, "bin");
  return null;
}

export function replicaAvailable(): boolean {
  if (!postgresBinDir()) return false;
  if (process.getuid && process.getuid() === 0) return spawnSync("id", ["postgres"]).status === 0;
  return true;
}

export const MONEY_FUNCTION_FILES = [
  "reserve_credits_atomic.sql",
  "create_quote_atomic.sql",
  "accept_quote_atomic.sql",
  "settle_job_atomic.sql",
  "settle_people_job_atomic.sql",
  "release_job_atomic.sql",
  "approve_topup_atomic.sql",
  "claim_complete_failure_functions.sql",
  "ledger_trigger_and_provider_functions.sql",
] as const;

export function withTerminator(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

/** The text of a saved definition file with a closing semicolon after the last function. */
export function readDefinition(file: string, dir: string = DEFINITIONS_DIR): string {
  return withTerminator(readFileSync(path.join(dir, file), "utf8"));
}

export interface ReplicaDb {
  pool: Pool;
  port: number;
  /** Run the same SQL text (one or many statements) as the database owner. */
  exec(sql: string): Promise<void>;
  /** Drop and rebuild everything: schema, the saved real function bodies, the triggers, the grants. */
  reset(options?: { functionsDir?: string; beforeFunctions?: string[]; extraSql?: string[] }): Promise<void>;
  stop(): Promise<void>;
}

function asPostgres(bin: string, args: string[], input?: string): string {
  const isRoot = process.getuid && process.getuid() === 0;
  const cmd = isRoot ? "runuser" : bin;
  const argv = isRoot ? ["-u", "postgres", "--", bin, ...args] : args;
  return execFileSync(cmd, argv, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

export async function startReplica(): Promise<ReplicaDb> {
  const binDir = postgresBinDir();
  if (!binDir) throw new Error("no local PostgreSQL server found");
  const isRoot = !!(process.getuid && process.getuid() === 0);
  const dir = mkdtempSync(path.join(tmpdir(), "diger-replica-"));
  if (isRoot) {
    const pg = spawnSync("id", ["-u", "postgres"], { encoding: "utf8" });
    const gid = spawnSync("id", ["-g", "postgres"], { encoding: "utf8" });
    chownSync(dir, Number(pg.stdout.trim()), Number(gid.stdout.trim()));
  }
  const data = path.join(dir, "data");
  asPostgres(path.join(binDir, "initdb"), ["-D", data, "-A", "trust", "-U", "postgres", "--no-sync", "-E", "UTF8", "--locale=C.UTF-8"]);
  const port = 20000 + Math.floor(Math.random() * 20000);
  asPostgres(path.join(binDir, "pg_ctl"), ["-D", data, "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c max_connections=200`, "-w", "-l", path.join(dir, "log.txt"), "start"]);
  const pool = new Pool({ host: "127.0.0.1", port, user: "postgres", database: "postgres", max: 60 });
  const exec = async (sql: string) => { await pool.query(sql); };
  const reset: ReplicaDb["reset"] = async (options = {}) => {
    const functionsDir = options.functionsDir ?? DEFINITIONS_DIR;
    await exec("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;");
    await exec(readFileSync(path.join(REPLICA_DIR, "prod_schema.sql"), "utf8"));
    for (const extra of options.beforeFunctions ?? []) await exec(extra);
    for (const file of MONEY_FUNCTION_FILES) {
      // a proposal directory holds only the functions it changes; every other body is the production one
      await exec(readDefinition(file, existsSync(path.join(functionsDir, file)) ? functionsDir : DEFINITIONS_DIR));
    }
    await exec(readFileSync(path.join(REPLICA_DIR, "prod_triggers.sql"), "utf8"));
    // production ACL: EXECUTE for postgres and service_role only, nothing for PUBLIC, anon, authenticated
    await exec(`DO $$ DECLARE r record; BEGIN
      FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
      END LOOP; END $$;`);
    for (const extra of options.extraSql ?? []) await exec(extra);
  };
  const stop = async () => {
    await pool.end().catch(() => undefined);
    try { asPostgres(path.join(binDir, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"]); } catch { /* already stopped */ }
    rmSync(dir, { recursive: true, force: true });
  };
  return { pool, port, exec, reset, stop };
}
