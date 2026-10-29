import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { POOL_CIPHERTEXT_FORMAT, PoolCryptoError, decryptPoolKey, encryptPoolKey, parsePoolEncryptionKey } from "../src/lib/server/tregPoolCrypto";
import { fakePoolDb } from "./helpers/tregPoolKit";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const SQL_DIR = "docs/proposals/treg-key-pool";
const sqlFiles = ["03_treg_pool_functions.sql", "04_treg_pool_cron.sql", "06_treg_pool_check_keys.sql"];

/** function name -> parameter names, from the SQL proposals the owner applied. */
function sqlFunctions(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of sqlFiles) {
    const text = read(`${SQL_DIR}/${f}`);
    for (const m of text.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)/g)) {
      out.set(m[1], [...m[2].matchAll(/\b(p_\w+)\b/g)].map((x) => x[1]));
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out); else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("the application and the SQL proposals agree (names and argument lists)", () => {
  const fns = sqlFunctions();
  const CODE = ["src/lib/server/tregKeyPool.ts", "src/lib/server/tregPoolAdmin.ts", "src/lib/server/tregPoolHealth.ts", "src/lib/server/tregPoolAlerts.ts", "src/app/api/cron/treg-pool/route.ts", "agent/src/main.ts"];

  it("every function the code calls exists in the SQL, and every argument it passes is a parameter of that function", () => {
    const used: Array<[string, string[], string]> = [];
    for (const file of CODE) {
      const text = read(file);
      for (const m of text.matchAll(/rpc\(\s*(?:deps,\s*)?"((?:treg_pool_|admin_)\w+)"\s*,\s*(\{[^}]*\})/g)) {
        used.push([m[1], [...m[2].matchAll(/\b(p_\w+)\s*:/g)].map((x) => x[1]), file]);
      }
    }
    expect(used.length).toBeGreaterThan(15);
    for (const [name, args, file] of used) {
      expect(fns.has(name), `${name} (${file}) is not in the SQL`).toBe(true);
      for (const a of args) expect(fns.get(name)!.includes(a), `${name} has no parameter ${a} (${file})`).toBe(true);
    }
  });

  it("the test model of the database implements only functions that exist in the SQL", () => {
    const db = fakePoolDb();
    const names = [...new Set(db.client.rpc.mock.calls.map((c: any[]) => c[0]))];
    expect(names).toEqual([]); // nothing called yet; the handlers are checked through the source below
    const kit = read("tests/helpers/tregPoolKit.ts");
    const handlerNames = [...kit.matchAll(/^\s{4}((?:treg_pool_|admin_)\w+):/gm)].map((m) => m[1]);
    expect(handlerNames.length).toBeGreaterThan(15);
    for (const n of handlerNames) expect(fns.has(n), `${n} is modelled but not in the SQL`).toBe(true);
  });

  it("the pool never reads a key variable itself and never reaches into a table directly", () => {
    for (const file of CODE.filter((f) => f.startsWith("src/"))) {
      const text = read(file);
      expect(text, file).not.toMatch(/process\.env\.(TREG_TOKEN|TREG_API_KEY)/);
      expect(text, file).not.toMatch(/\.from\(\s*["']treg_pool_keys["']\s*\)/);
    }
  });

  it("a client component imports nothing of the server except types, and holds no secret handling", () => {
    const ui = read("src/components/admin/TregKeyPool.tsx");
    for (const m of ui.matchAll(/^import\s+(?!type)[^;]*from\s+["']([^"']+)["']/gm)) expect(m[1], `non-type import ${m[1]}`).not.toMatch(/lib\/server|node:/);
    expect(ui).not.toMatch(/process\.env|ciphertext|plaintext/);
  });

  it("no client file reads the pool tables or functions directly (they are service-role only)", () => {
    for (const file of walk(path.join(root, "src/components")).concat(walk(path.join(root, "src/app")).filter((f) => /\.tsx$/.test(f)))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/treg_pool_/);
    }
  });
});

describe("the SQL proposals are additive and keep the access rules", () => {
  // statements only: the headers' comments name the money tables precisely to say they are not touched
  const sql = sqlFiles.concat(["01_vault_encryption_key.sql", "02_treg_pool_tables.sql"]).map((f) => read(`${SQL_DIR}/${f}`)).join("\n").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("nothing existing is altered or dropped, and no money object is mentioned", () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|FUNCTION|TRIGGER|INDEX|COLUMN)\b(?![^;]*treg_pool|[^;]*block_treg_pool)/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+public\.(?!treg_pool_)/i);
    expect(sql).not.toMatch(/\b(credit_ledger|topups|plans_quotes|profiles|approve_topup|reserve_job|settle_job|release_job)\b/);
  });

  it("every function is SECURITY DEFINER with a pinned search_path and revoked from anon and authenticated", () => {
    const fnCount = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(treg_pool_\w+|admin_\w*treg\w+)\(/g)].length;
    expect(fnCount).toBeGreaterThanOrEqual(23);
    const defs = sql.split(/CREATE OR REPLACE FUNCTION /).slice(1).filter((d) => /^public\.(treg_pool_|admin_\w*treg)/.test(d));
    for (const d of defs) {
      expect(d.slice(0, d.indexOf("$$")), d.slice(0, 40)).toMatch(/SECURITY DEFINER/);
      expect(d, d.slice(0, 40)).toMatch(/search_path TO 'public', 'pg_temp'/);
    }
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.treg_pool_runtime\(\) FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.treg_pool_keys\s+FROM PUBLIC, anon, authenticated, service_role/);
  });
});

describe("the pool's encryption", () => {
  const enc = randomBytes(32).toString("base64");
  const id = "10000000-0000-0000-0000-000000000001";

  it("round-trips, matches the shape the SQL accepts, and never contains the plaintext", () => {
    const secret = "testonly-" + randomBytes(12).toString("hex");
    const ct = encryptPoolKey(enc, id, secret);
    expect(ct).toMatch(POOL_CIPHERTEXT_FORMAT);
    expect(new RegExp(read(`${SQL_DIR}/02_treg_pool_tables.sql`).match(/ciphertext ~ '([^']+)'/)![1]).test(ct)).toBe(true);
    expect(ct).not.toContain(secret);
    expect(decryptPoolKey(enc, id, ct)).toBe(secret);
    expect(encryptPoolKey(enc, id, secret)).not.toBe(ct); // a fresh nonce every time
  });

  it("a ciphertext cannot be moved to another row, read with another Vault key, or tampered with", () => {
    const ct = encryptPoolKey(enc, id, "testonly-secret-value-1");
    expect(() => decryptPoolKey(enc, "10000000-0000-0000-0000-000000000002", ct)).toThrow(PoolCryptoError);
    expect(() => decryptPoolKey(randomBytes(32).toString("base64"), id, ct)).toThrow(PoolCryptoError);
    const parts = ct.split(".");
    parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    expect(() => decryptPoolKey(enc, id, parts.join("."))).toThrow(/decrypt_failed/);
    expect(() => decryptPoolKey(enc, id, "not-a-ciphertext")).toThrow(/ciphertext_invalid/);
  });

  it("refuses a missing or malformed Vault key with a fixed reason code and never the value", () => {
    expect(() => parsePoolEncryptionKey("")).toThrow(/encryption_key_missing/);
    expect(() => parsePoolEncryptionKey("c2hvcnQ=")).toThrow(/encryption_key_invalid/);
    try { parsePoolEncryptionKey("!!!not base64!!!"); } catch (e) { expect(String((e as Error).message)).not.toContain("not base64"); }
  });
});
