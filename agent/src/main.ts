import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { createCallRecorder } from "../../src/lib/server/multiProvider/callRecorder";
import { resolveAccountAccess } from "../../src/lib/server/sensitiveAccess";
import { sendMissionNotice } from "../../src/lib/server/missionNotify";
import { resolveProviderKey, useProviderKeyStoreClient } from "../../src/lib/server/providerKeys";
import { last4Of } from "../../src/lib/server/providerKeyCrypto";
import { sendPlatformEmail } from "../../src/lib/server/sendPlatformEmail";
import { configureTregKeyPool } from "../../src/lib/server/tregKeyPool";
import { buildPoolAlertVars } from "../../src/lib/server/tregPoolAlerts";
import { ownerAlertRecipient } from "../../src/lib/server/topupOwnerAlert";
import { AGENT_CONCURRENCY_ENV, AGENT_MODEL_DEFAULT } from "../../src/lib/agentMission/constants";
import { parseConcurrency } from "../../src/lib/agentMission/concurrency";
import { resolveModels } from "./modelConfig";
import { runMissionSafely, type RunnerDeps } from "./runMission";
import { anthropicReviewCall } from "./review";
import { createSdkDriver } from "./sdkRuntime";
import { abortActiveRuns } from "./sessions";
import { createSupabaseStore } from "./supabaseStore";
import { createWorker } from "./worker";

/**
 * The entry point of the Heroku worker dyno (`worker: npx tsx agent/src/main.ts`). Required environment variables (names only; the values are set in Heroku, never in the repository):
 *   ANTHROPIC_API_KEY, TREG_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY            AGENT_MODEL is optional (default claude-haiku-5-5); ADMIN_ALERT_EMAIL is optional (a direct notice when the key pool's database is unreachable);
 *   AGENT_CONCURRENCY is optional (default 1, at most 4).
 */
const REQUIRED = ["ANTHROPIC_API_KEY", "TREG_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const VERSION = process.env.SOURCE_VERSION?.slice(0, 7) || process.env.HEROKU_SLUG_COMMIT?.slice(0, 7) || "dev";

async function main() {
  // the site's e-mail helper (src/lib/server/sendPlatformEmail.ts) reads the Supabase URL under its public name: the worker has the same project URL under SUPABASE_URL
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`[agent] missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
  const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const store = createSupabaseStore(client);
  useProviderKeyStoreClient(client);
  // The TREG key pool (docs/proposals/treg-key-pool): with the rollout switch ON every call of this worker uses the pool's active key, read every 3 seconds (a switch needs no restart);
  // OFF, or when the pool cannot be read, the worker uses TREG_TOKEN exactly as before (it is the main key then). The optional ADMIN_ALERT_EMAIL here lets the worker tell the owner
  // directly when the database itself is unreachable; otherwise that notice is queued and goes out as soon as the database answers.
  configureTregKeyPool({
    source: "worker",
    getClient: async () => client,
    onEmergency: async ({ reason }) => {
      const to = ownerAlertRecipient();
      if (!to) return;
      await sendPlatformEmail("job-update", to, buildPoolAlertVars({ problem: "store_unreadable", key_number: null, key_label: null, to_key_number: null, to_key_label: null, reason, created_at: new Date().toISOString() }), `treg-pool-worker-${Date.now().toString(36)}`);
    },
  });
  const reportTokenTail = () => { void Promise.resolve(client.rpc("treg_pool_note_worker", { p_env_last4: last4Of(process.env.TREG_TOKEN) ?? "" })).catch(() => undefined); };
  reportTokenTail();
  setInterval(reportTokenTail, 600_000).unref();
  const catalog = loadTregCatalog();
  const driver = createSdkDriver(process.env);
  const recorder = createCallRecorder(client);
  const workerId = `w_${process.env.DYNO ?? "local"}_${randomUUID().slice(0, 8)}`;
  const log = (line: string) => console.log(`[agent] ${line}`);

  let models = resolveModels(process.env, {});
  const refreshModels = async () => { models = resolveModels(process.env, await store.readSettings().catch(() => ({}))); };
  await refreshModels();
  setInterval(() => { void refreshModels(); }, 30_000).unref();

  const deps = (): RunnerDeps => ({
    store, client, catalog, driver, recorder, models, token: process.env.TREG_TOKEN,
    resolveAccess: (userId) => resolveAccountAccess(client, userId),
    // the review of uncertain rows: one small request per batch to the model API (the SDK's native process is never started for it)
    reviewCall: anthropicReviewCall(process.env.ANTHROPIC_API_KEY!),
    // the customer's notice when a mission ends: an in-site notification and an e-mail through the existing send-email function
    notify: (n) => sendMissionNotice(client, n),
    // the Firecrawl and Context.dev keys come from the SAME encrypted provider key store the website uses (needs PROVIDER_KEYS_ENCRYPTION_KEY, the same value as the website's); when the store gives no key the site's
    // environment names are read (CONTEXT_DEV_API_KEY / FIRECRAWL_API_KEY, see providerKeyCrypto.ts); with neither, the web tools answer «source unavailable» and the agent uses the catalog
    providerKey: async (provider) => (await resolveProviderKey(provider)).key || null,
    log,
  });

  const concurrency = parseConcurrency(process.env[AGENT_CONCURRENCY_ENV]);
  const worker = createWorker({
    store, workerId, version: VERSION, log, concurrency,
    // at the memory hard limit the running model run is stopped; the mission goes back to the queue instead of the dyno being killed
    onMemoryPressure: () => { abortActiveRuns("memory"); },
    modelLabel: () => `${models.planning}/${models.execution}`.slice(0, 80) || AGENT_MODEL_DEFAULT,
    // a recycled worker (idle at or above the admit limit for too long) stops its loop; the process exits and the platform restarts it with a fresh heap
    onRecycle: () => { worker.stop(); },
    // every claimed mission ends in a clean state whatever happens in the run (runMission.ts: runMissionSafely)
    runMission: (mission) => runMissionSafely(deps(), mission),
  });

  const shutdown = () => { log("shutting down: no new missions; running ones keep their lease until it ends"); worker.stop(); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  log(`worker ${workerId} started (${VERSION}); planning ${models.planning}, execution ${models.execution}, ${concurrency} mission(s) at a time`);
  await worker.run();
  await Promise.race([worker.idle(), new Promise((r) => setTimeout(r, 20_000))]);
  process.exit(0);
}

main().catch((e) => {
  console.error("[agent] fatal", String((e as Error)?.message ?? e).slice(0, 300));
  process.exit(1);
});
