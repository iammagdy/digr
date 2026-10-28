import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { createCallRecorder } from "../../src/lib/server/multiProvider/callRecorder";
import { resolveAccountAccess } from "../../src/lib/server/sensitiveAccess";
import { sendMissionNotice } from "../../src/lib/server/missionNotify";
import { resolveProviderKey, useProviderKeyStoreClient } from "../../src/lib/server/providerKeys";
import { AGENT_CONCURRENCY_ENV, AGENT_MODEL_DEFAULT } from "../../src/lib/agentMission/constants";
import { parseConcurrency } from "../../src/lib/agentMission/concurrency";
import { resolveModels } from "./modelConfig";
import { runExecution, runPlanning, type RunnerDeps } from "./runMission";
import { createSdkDriver } from "./sdkRuntime";
import { abortActiveRuns } from "./sessions";
import { createSupabaseStore } from "./supabaseStore";
import { createWorker } from "./worker";

/**
 * The entry point of the Heroku worker dyno (`worker: npx tsx agent/src/main.ts`). Required environment variables (names only; the values are set in Heroku, never in the repository):
 *   ANTHROPIC_API_KEY, TREG_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY            AGENT_MODEL is optional (default claude-haiku-5-5);
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
    runMission: async (mission) => {
      try {
        if (mission.status === "planning") await runPlanning(deps(), mission);
        else if (mission.status === "executing") await runExecution(deps(), mission);
      } catch (e) {
        // never leave a mission leased to a worker that gave up on it: the lease ends and the mission is taken over; the error is recorded
        log(`mission_error ${mission.id} ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        await store.updateMission(mission.id, { error: String((e as Error)?.message ?? e).slice(0, 300) }).catch(() => undefined);
      }
    },
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
