import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { tiktokWorld } from "./helpers/round11Worlds";

const state = vi.hoisted(() => ({ viewer: { userId: "u-1", isGuest: false, emailVerified: true } as any, client: null as any, viewerCalls: 0, adminCalls: 0 }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => { state.adminCalls += 1; return state.client; }, createServerSideClient: vi.fn() }));
vi.mock("../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async () => { state.viewerCalls += 1; return state.viewer ? { ok: true, viewer: state.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) }; }) };
});

import { GET } from "../src/app/api/missions/[id]/versions/route";
import VersionList, { VersionListBody } from "../src/components/mission/VersionList";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import { firstVersionFromCells, versionPathOf, type FileVersion } from "../src/lib/agentMission/stage4/versions";
import { VERSIONS_HEADING_AR, VERSIONS_NOTE_AR, versionLabelAr, versionParentAr, type VersionSummary } from "../src/lib/agentMission/stage4/versionLabels";
import { listVersionSummaries } from "../src/lib/agentMission/stage4/versionList";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";

/**
 * STAGE 4, S2 (docs/STAGE-4.md section 8): THE VERSIONS LIST, behind DIGER_STAGE4_VERSIONS. GET /api/missions/[id]/versions: flag off -> 404 (before anyone is asked who they are), owner only, never cached, the five fields of each version
 * from the `versions/` listing and nothing else. The component draws «النسخة ١ (التسليم)» and so on, and nothing at all when there is nothing to show.
 */
const MISSION = "msn_5851abc92a1e6645a9cd";
const ME = "u-1";
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => { state.viewer = { userId: ME, isGuest: false, emailVerified: true }; state.viewerCalls = 0; state.adminCalls = 0; });

/** A client with the missions table and a storage bucket of named objects (the real listing answers entries with an id; a folder has none). */
function clientWith(objects: Record<string, string>, opts: { email?: string; listError?: boolean } = {}) {
  const db = createMemoryDb();
  db.seed("missions", [{ id: MISSION, user_id: ME, status: "completed" }, { id: "msn_aaaaaaaaaaaaaaaaaaaa", user_id: "u-2", status: "completed" }]);
  const bucket = {
    list: async (dir: string) => opts.listError ? { data: null, error: { message: "down" } } : { data: [...new Set(Object.keys(objects).filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1).split("/")[0]))].map((name) => ({ name, id: Object.keys(objects).includes(`${dir}/${name}`) ? `id_${name}` : null })), error: null },
    download: async (p: string) => (objects[p] === undefined ? { data: null, error: { message: "missing" } } : { data: new Blob([objects[p]]), error: null }),
  };
  return { from: (t: string) => db.from(t), storage: { from: () => bucket }, auth: { admin: { getUserById: async () => ({ data: { user: { email: opts.email ?? "customer@example.com" } } }) } } };
}
const call = async (id = MISSION) => GET(new NextRequest(`http://localhost/api/missions/${id}/versions`), { params: Promise.resolve({ id }) });

async function storedVersions(): Promise<{ v1: FileVersion; v2: FileVersion; objects: Record<string, string> }> {
  const { cells } = await tiktokWorld();
  const v1 = firstVersionFromCells({ missionId: MISSION, cells, createdAt: "2026-11-02T12:00:00.000Z" });
  const sheet = v1.sheets[0];
  const r = applyEditRequest(v1, { kind: "add_column", sheet: sheet.nameAr, titleAr: "ملاحظة", values: Object.fromEntries(sheet.rows.map((x) => [x.id, "ملاحظة"])) }, { createdAt: "2026-11-03T09:30:00.000Z" });
  if (!r.ok) throw new Error(`the fixture edit was refused: ${r.reason}`);
  return { v1, v2: r.version, objects: { [`${MISSION}/${versionPathOf(1)}`]: JSON.stringify(v1), [`${MISSION}/${versionPathOf(2)}`]: JSON.stringify(r.version) } };
}

describe("flag off: the route does not exist", () => {
  it("404 and no-store, before the viewer or the database is touched", async () => {
    state.client = clientWith({});
    for (const v of [undefined, "", "off", "yes", "true", "1"]) {
      if (v !== undefined) vi.stubEnv("DIGER_STAGE4_VERSIONS", v);
      const res = await call();
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(state.viewerCalls).toBe(0);
    expect(state.adminCalls).toBe(0);
  });
});

describe("flag on: owner only", () => {
  it("not signed in: 401 (the viewer's own answer)", async () => {
    vi.stubEnv("DIGER_STAGE4_VERSIONS", "on");
    state.client = clientWith({}); state.viewer = null;
    expect((await call()).status).toBe(401);
  });
  it("someone else's mission and a mission that does not exist read the same: 404, never cached", async () => {
    vi.stubEnv("DIGER_STAGE4_VERSIONS", "on");
    const { objects } = await storedVersions();
    state.client = clientWith({ ...objects, [`msn_aaaaaaaaaaaaaaaaaaaa/${versionPathOf(1)}`]: "{}" });
    for (const id of ["msn_aaaaaaaaaaaaaaaaaaaa", "msn_bbbbbbbbbbbbbbbbbbbb"]) {
      const res = await call(id);
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(JSON.stringify(await res.json())).not.toContain("digest");
    }
  });
  it("a bad id is 400", async () => {
    vi.stubEnv("DIGER_STAGE4_VERSIONS", "on");
    state.client = clientWith({});
    expect((await call("not-a-mission")).status).toBe(400);
  });
  it("«test» is not served by this customer-side route (the test-account list is never imported here): 404 for everyone; only «on» lists", async () => {
    const { objects } = await storedVersions();
    for (const email of ["customer@example.com", "iam.magdy+1@outlook.com"]) {
      vi.stubEnv("DIGER_STAGE4_VERSIONS", "test");
      state.client = clientWith(objects, { email });
      expect((await call()).status).toBe(404);
    }
    vi.stubEnv("DIGER_STAGE4_VERSIONS", "on");
    expect((await call()).status).toBe(200);
  });
});

describe("the list, on a stored real file (M12) and an edit made from it", () => {
  it("each version with its five fields, oldest first, no cell of the file, never cached", async () => {
    vi.stubEnv("DIGER_STAGE4_VERSIONS", "on");
    const { v1, v2, objects } = await storedVersions();
    state.client = clientWith(objects);
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    const expected: VersionSummary[] = [
      { version: 1, parent: null, reason: "delivery", createdAt: "2026-11-02T12:00:00.000Z", digest: v1.digest },
      { version: 2, parent: 1, reason: "edit", createdAt: "2026-11-03T09:30:00.000Z", digest: v2.digest },
    ];
    expect(body).toEqual({ success: true, versions: expected });
    expect(Object.keys(body.versions[0]).sort()).toEqual(["createdAt", "digest", "parent", "reason", "version"]);
    expect(v1.digest).not.toBe(v2.digest);
    expect(JSON.stringify(body)).not.toContain(v1.sheets[0].rows[0].cells.find((c) => c.length > 12) ?? "\u0000none");
  }, 60_000);

  it("an object that is not a well-formed version, a stray file and a folder are left out; a mission with none gives an empty list", async () => {
    vi.stubEnv("DIGER_STAGE4_VERSIONS", "on");
    const { v1, objects } = await storedVersions();
    const noise = { [`${MISSION}/versions/v0003.json`]: "not json", [`${MISSION}/versions/v0004.json`]: JSON.stringify({ ...v1, version: 9 }), [`${MISSION}/versions/v0005.json`]: JSON.stringify({ ...v1, version: 5, digest: "zz" }), [`${MISSION}/versions/notes.txt`]: "x", [`${MISSION}/versions/v0002/result.xlsx`]: "bytes" };
    const list = await listVersionSummaries(clientWith({ ...objects, ...noise }), MISSION);
    expect(list.map((v) => v.version)).toEqual([1, 2]);
    expect(await listVersionSummaries(clientWith({}), MISSION)).toEqual([]);
  }, 60_000);

  it("a listing that fails is 503 (never a partial list)", async () => {
    vi.stubEnv("DIGER_STAGE4_VERSIONS", "on");
    state.client = clientWith({}, { listError: true });
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("the route only reads: no write, no price, no money", () => {
    const code = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const src = code("../src/app/api/missions/[id]/versions/route.ts") + code("../src/lib/agentMission/stage4/versionList.ts");
    expect(src).not.toMatch(/\.(upload|insert|update|upsert|delete|remove|rpc)\(/);
    expect(src).not.toMatch(/quotes|price|ledger|charge/i);
  });
});

describe("the component", () => {
  const rows: VersionSummary[] = [
    { version: 1, parent: null, reason: "delivery", createdAt: "2026-11-02T12:00:00.000Z", digest: "a".repeat(64) },
    { version: 2, parent: 1, reason: "edit", createdAt: "2026-11-03T09:30:00.000Z", digest: "b".repeat(64) },
    { version: 3, parent: 2, reason: "review_fix", createdAt: "2026-11-03T10:30:00.000Z", digest: "c".repeat(64) },
  ];
  it("«النسخة ١ (التسليم)», «النسخة ٢ (تعديل)» and the fix, with Arabic-Indic numerals and no button", () => {
    const html = renderToStaticMarkup(createElement(VersionListBody, { versions: rows }));
    expect(html).toContain("النسخة ١ (التسليم)");
    expect(html).toContain("النسخة ٢ (تعديل)");
    expect(html).toContain("النسخة ٣ (إصلاح من المراجعة)");
    expect(html).toContain("مأخوذة من النسخة ١");
    expect(html).toContain(VERSIONS_HEADING_AR);
    expect(html).toContain(VERSIONS_NOTE_AR);
    expect(html).not.toMatch(/<button|<a |href=/);
    const text = html.replace(/<[^>]+>/g, " ");
    expect(text).not.toMatch(/[0-9]/);
  });
  it("nothing at all when there is no version (the flag off, or none stored)", () => {
    expect(renderToStaticMarkup(createElement(VersionListBody, { versions: [] }))).toBe("");
    expect(renderToStaticMarkup(createElement(VersionList, { missionId: MISSION }))).toBe("");
  });
  it("every sentence it can show passes the customer-text rules, for every reason and for numbers up to a hundred", () => {
    const all: string[] = [VERSIONS_HEADING_AR, VERSIONS_NOTE_AR];
    for (let n = 1; n <= 100; n++) for (const reason of ["delivery", "edit", "review_fix"] as const) { all.push(versionLabelAr(n, reason)); if (n > 1) all.push(versionParentAr(n - 1)); }
    for (const s of all) { expect(checkCustomerText(s).issues, s).toEqual([]); expect(checkCustomerLabel(s).issues, s).toEqual([]); expect(s, s).not.toMatch(/[0-9]/); }
    expect(versionParentAr(null)).toBe("");
  });
});

describe("only the request's page shows it", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  it("the requests page renders it; the chat page, the mission card and the results canvas do not mention it", () => {
    expect(read("src/app/dashboard/requests/[id]/page.tsx")).toContain("<VersionList missionId={missionId} />");
    for (const p of ["src/app/dashboard/chat/page.tsx", "src/components/mission/AgentMissionCard.tsx", "src/components/chat/ResultsCanvas.tsx"]) {
      try { expect(read(p), p).not.toMatch(/VersionList|stage4/); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
  });
});
