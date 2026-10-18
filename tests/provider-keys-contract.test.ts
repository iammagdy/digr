import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const tables = read("supabase/migrations/20261018160000_provider_api_keys_tables.sql");
const functions = read("supabase/migrations/20261018160500_provider_api_keys_functions.sql");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

describe("every provider call site uses the shared resolver", () => {
  const RESOLVER = path.join("src", "lib", "server", "providerKeys.ts");
  const DIRECT = /process\.env\s*(?:\.\s*(TREG_TOKEN|TREG_API_KEY|ANTHROPIC_API_KEY)\b|\[\s*["'`](TREG_TOKEN|TREG_API_KEY|ANTHROPIC_API_KEY)["'`]\s*\])/;
  const DESTRUCTURED = /(?:const|let|var)\s*\{[^}]*\b(TREG_TOKEN|TREG_API_KEY|ANTHROPIC_API_KEY)\b[^}]*\}\s*=\s*process\.env/;

  it("no source file outside the resolver reads the TREG or Anthropic key variables", () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(root, "src"))) {
      const rel = path.relative(root, file);
      if (rel === RESOLVER) continue;
      const text = readFileSync(file, "utf8");
      if (DIRECT.test(text) || DESTRUCTURED.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("the resolver is the only reader, and it names the variables once", () => {
    const text = read(RESOLVER);
    expect(text).toMatch(/TREG_TOKEN/);
    expect(text).toMatch(/ANTHROPIC_API_KEY/);
    expect(text).toMatch(/process\.env\[name\]/);
  });

  it("every provider-facing module imports the resolver", () => {
    for (const [file, name] of [
      ["src/functions/shared/tregClient.ts", "resolveProviderKey"],
      ["src/functions/shared/catalogClient.ts", "resolveProviderKey"],
      ["src/functions/shared/smokeTest.ts", "resolveProviderKey"],
      ["src/functions/shared/llmClient.ts", "resolveProviderKey"],
      ["src/lib/server/relevanceValidationLayer.ts", "resolveProviderKey"],
      ["src/lib/server/providerGate.ts", "resolveProviderKey"],
      ["src/lib/server/tregAdapter.ts", "resolveProviderKey"],
      ["src/app/api/admin/providers/route.ts", "resolveProviderKey"],
    ] as const) {
      expect(read(file), file).toContain(name);
    }
  });

  it("the encryption key variable is never read in client code and the bundle scan watches for it", () => {
    for (const file of walk(path.join(root, "src"))) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("PROVIDER_KEYS_ENCRYPTION_KEY")) continue;
      if (/^\s*["']use client["']/.test(text)) throw new Error(`client file mentions the encryption key: ${file}`);
    }
    expect(read("scripts/check-client-bundle-secrets.ts")).toContain("PROVIDER_KEYS_ENCRYPTION_KEY");
  });
});

describe("migration contract (proposal files, never applied by the author)", () => {
  it("tables: RLS on, no access for public/anon/authenticated, service_role may only SELECT", () => {
    expect(tables).toMatch(/ALTER TABLE public\.provider_api_keys ENABLE ROW LEVEL SECURITY/);
    expect(tables).toMatch(/ALTER TABLE public\.provider_key_audit ENABLE ROW LEVEL SECURITY/);
    expect(tables).toMatch(/REVOKE ALL ON TABLE public\.provider_api_keys FROM PUBLIC, anon, authenticated/);
    expect(tables).toMatch(/REVOKE ALL ON TABLE public\.provider_key_audit FROM PUBLIC, anon, authenticated/);
    expect(tables).toMatch(/GRANT SELECT ON TABLE public\.provider_api_keys TO service_role/);
    expect(tables).toMatch(/GRANT SELECT ON TABLE public\.provider_key_audit TO service_role/);
    expect(tables).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO (service_role|anon|authenticated)/i);
  });

  it("audit table is append-only with a trigger on UPDATE and DELETE and stores last4 only", () => {
    expect(tables).toMatch(/BEFORE UPDATE OR DELETE ON public\.provider_key_audit/);
    expect(tables).toMatch(/append-only/);
    expect(tables).toMatch(/last4 text CHECK \(last4 IS NULL OR char_length\(last4\) BETWEEN 1 AND 4\)/);
    expect(tables).not.toMatch(/audit[^;]*plaintext/i);
  });

  it("functions: SECURITY DEFINER, pinned search_path, service_role only, admin verified inside", () => {
    for (const fn of ["admin_set_provider_key_atomic", "admin_rollback_provider_key_atomic"]) {
      expect(functions).toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}`));
      expect(functions).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
      expect(functions).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role`));
    }
    expect(functions.match(/^SECURITY DEFINER$/gm)).toHaveLength(2);
    expect(functions.match(/SET search_path TO 'public', 'pg_temp'/g)).toHaveLength(2);
    expect(functions.match(/raw_app_meta_data ->> 'role'/g)).toHaveLength(2);
    expect(functions.match(/'not_admin'/g)).toHaveLength(2);
    expect(functions.match(/INSERT INTO public\.provider_key_audit/g)).toHaveLength(2);
  });

  it("functions accept only ciphertext in the application format, never a plaintext key parameter", () => {
    expect(functions).toMatch(/p_ciphertext text/);
    expect(functions).not.toMatch(/p_(api_)?key\b|p_secret|p_plaintext/i);
    expect(functions).toMatch(/\^v1\\\./);
  });

  it("the migrations touch no money table", () => {
    for (const text of [tables, functions]) {
      for (const money of ["credit_ledger", "jobs", "topups", "plans_quotes", "provider_costs", "profiles"]) {
        expect(text).not.toMatch(new RegExp(`(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE|FROM|JOIN)\\s+public\\.${money}\\b`));
      }
    }
  });

  it("the apply guide lists both files in order with one check per file and a rollback", () => {
    const doc = read("docs/APPLY_MIGRATIONS_3.md");
    expect(doc.indexOf("20261018160000_provider_api_keys_tables.sql")).toBeGreaterThan(-1);
    expect(doc.indexOf("20261018160500_provider_api_keys_functions.sql")).toBeGreaterThan(doc.indexOf("20261018160000_provider_api_keys_tables.sql"));
    expect(doc).toMatch(/PROVIDER_KEYS_ENCRYPTION_KEY/);
    expect(doc).toMatch(/Rollback/i);
  });
});

describe("admin screens", () => {
  const page = read("src/app/admin/providers/page.tsx");
  const tab = read("src/components/admin/ProviderTab.tsx");

  it("one tab per provider, the data provider first", () => {
    expect(page).toMatch(/role="tablist"/);
    expect(page.indexOf('["treg", "مزود البيانات"]')).toBeGreaterThan(-1);
    expect(page.indexOf('["treg", "مزود البيانات"]')).toBeLessThan(page.indexOf('["anthropic", "مزود النموذج الذكي"]'));
    expect(page).toMatch(/useState<TabId>\("treg"\)/);
  });

  it("shows a real check, a real balance with refresh, spend against the cap, masked key, replace, rollback and activity", () => {
    for (const needle of ["تحديث الآن", "الرصيد لدى المزود", "رمز الاستجابة", "زمن الاستجابة", "وقت آخر فحص", "استبدال المفتاح", "الرجوع للمفتاح السابق", "آخر النشاط", "السقف اليومي", "حد تنبيه الرصيد المنخفض", "فحص وحفظ"]) {
      expect(tab, needle).toContain(needle);
    }
    expect(tab).toMatch(/type="password"/);
    expect(tab).not.toMatch(/alert\(|confirm\(/);
  });

  it("the old flag-based status is gone: the sidebar dots come from the real check", () => {
    const shell = read("src/components/admin/AdminShell.tsx");
    expect(shell).not.toMatch(/providers\.treg\.live \? "var\(--ok\)"/);
    expect(shell).toContain("providers.treg.health");
    expect(shell).toContain("متصل فعليًا");
    expect(page).not.toMatch(/TREG_LIVE=true|TREG_TOKEN/);
  });

  it("the admin home has a visible low-balance banner", () => {
    expect(read("src/app/admin/page.tsx")).toContain("<ProviderAlertBanner />");
    const banner = read("src/components/admin/ProviderAlertBanner.tsx");
    expect(banner).toMatch(/role="alert"/);
    expect(banner).toContain("رصيدك لدى مزود البيانات منخفض");
  });
});
