import { describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { isInternalEvent } from "../src/lib/agentMission/eventText";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { NOT_ADMIN, USER_ID, fakeRecorder } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";

/**
 * WHETHER THE DEPLOYED WORKER CAN REACH THE WEB PROVIDERS, IN THE DATABASE (round 53). Production refused all 71 Firecrawl / Context.dev calls of Oct 29-30 as «no key configured» and offered none in the 133 missions since, although
 * both keys are in the encrypted store: the worker most likely lacks the store's decryption secret. Each planning run now records two booleans for the admin (never a key, never shown to the customer).
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

async function plan(providerKey: RunnerDeps["providerKey"]) {
  const store = createMemoryStore();
  const rec = fakeRecorder();
  const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog: loadTregCatalog(), driver: createFakeDriver([]), recorder: rec.recorder, commit: rec.commit, call: vi.fn() as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined, ...(providerKey ? { providerKey } : {}) };
  store.missions.set("msn_web", newMission({ id: "msn_web", user_id: USER_ID, status: "planning", request_text: "عايز مقالات عن الطاقة الشمسية في مصر" }));
  await runPlanning(deps, store.missions.get("msn_web")!);
  return store.events.filter((e) => e.counts && "adm_web_firecrawl" in e.counts);
}

describe("the worker records whether it could reach Firecrawl and Context.dev when it planned", () => {
  it("no key resolved: both 0", async () => {
    const ev = await plan(async () => null);
    expect(ev).toHaveLength(1);
    expect(ev[0].counts).toEqual({ adm_web_firecrawl: 0, adm_web_contextdev: 0 });
    expect(isInternalEvent(ev[0])).toBe(true);
  });
  it("one key resolved: that one is 1, and no key material is recorded", async () => {
    const ev = await plan(async (provider) => (provider === "firecrawl" ? "fc-secret-value-xyz" : null));
    expect(ev[0].counts).toEqual({ adm_web_firecrawl: 1, adm_web_contextdev: 0 });
    expect(JSON.stringify(ev)).not.toContain("secret-value");
  });
  it("a worker built without the key resolver (tests, replays) records nothing", async () => {
    expect(await plan(undefined)).toHaveLength(0);
  });
});
