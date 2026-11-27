/**
 * Staged pressure test: N virtual visitors against a PREVIEW deployment (fake provider) and a SEPARATE test database.
 * Run by the owner, never by an agent, never against the live site (docs/PRESSURE_TEST_RUNBOOK.md):
 *
 *   PRESSURE_TEST_CONFIRM=preview-and-test-database \
 *   TEST_SUPABASE_URL=... TEST_SUPABASE_ANON_KEY=... TEST_SUPABASE_SERVICE_ROLE_KEY=... PRESSURE_PROMO_CODE=... \
 *   [PRESSURE_BYPASS_TOKEN=...] npx tsx scripts/pressure/run.ts --stage 50 --base https://<preview>.vercel.app
 *
 * This command now supports configuration validation and dry-run only. The former preview fixture exercised the retired quote routes.
 */
import { STAGES, safetyProblems } from "./lib";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

interface Config {
  base: string; dbUrl: string; anonKey: string; serviceKey: string; promoCode: string; bypass: string | undefined; stage: number; out: string;
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  const config: Config = {
    base: (arg("base") || "").replace(/\/$/, ""),
    dbUrl: (env.TEST_SUPABASE_URL || "").replace(/\/$/, ""),
    anonKey: env.TEST_SUPABASE_ANON_KEY || "",
    serviceKey: env.TEST_SUPABASE_SERVICE_ROLE_KEY || "",
    promoCode: env.PRESSURE_PROMO_CODE || "",
    bypass: env.PRESSURE_BYPASS_TOKEN || undefined,
    stage: Number(arg("stage") || 0),
    out: arg("out") || `pressure-stage-${arg("stage") || "x"}.json`,
  };
  const problems = safetyProblems({ base: config.base, testDatabaseUrl: config.dbUrl, confirm: env.PRESSURE_TEST_CONFIRM, stage: config.stage, allow500: flag("yes-500") });
  if (!config.anonKey || !config.serviceKey) problems.push("TEST_SUPABASE_ANON_KEY and TEST_SUPABASE_SERVICE_ROLE_KEY must be set (the TEST project's keys)");
  if (!config.promoCode) problems.push("PRESSURE_PROMO_CODE must be set (a promo code created in the TEST project's admin, with enough redemptions)");
  if (problems.length) {
    console.error("NOT STARTED:\n- " + problems.join("\n- "));
    return 2;
  }
  const stage = STAGES[config.stage];
  if (flag("dry-run")) {
    console.log(JSON.stringify({ dryRun: true, base: config.base, stage: config.stage, ...stage }, null, 2));
    return 0;
  }
  console.error("NOT STARTED: this pressure runner used retired chat quote actions. An offline agent-mission fixture is required before it can run again.");
  return 2;
}

if (process.argv[1] && /pressure[\\/]run\.ts$/.test(process.argv[1])) {
  main().then((code) => process.exit(code), () => { console.error("The run stopped on an unexpected error."); process.exit(3); });
}
