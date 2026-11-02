import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { strFromU8, unzipSync } from "fflate";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PR 1 of docs/FOUNDATION-PLAN.md («Real responses in»): an admin-only ZIP of the stored raw/ and rows/ objects of chosen missions, read from the
 * private bucket "agent-missions" through the server's existing Storage client. Read-only; nothing but raw/ and rows/; no content in any log.
 */

const M17 = "msn_6bb78c15d116268b0b9b";
const M19 = "msn_96beb9f7a1d937a90cd0";
/** The REAL object metadata of M17 (storage.objects, read-only SELECT of 2026-11-02): name -> size in bytes. */
const M17_RAW_SIZES: Array<[string, number]> = [
  ["call_0001.json", 714], ["call_0002.json", 5200], ["call_0003.json", 7899], ["call_0004.json", 66738], ["call_0005.json", 21812], ["call_0006.json", 5847],
  ["call_0007.json", 113], ["call_0008.json", 113], ["call_0009.json", 7802], ["call_0010.json", 294], ["call_0011.json", 294], ["call_0012.json", 294], ["call_0013.json", 294],
];
const M17_ROWS_SIZES: Array<[string, number]> = [["comments.json", 4427], ["comments_replies.json", 2], ["posts.json", 4273]];
/** What else the real mission folder holds (must never reach the ZIP). */
const M17_OTHER: Array<[string, number]> = [
  ["out/out_0001.json", 2244], ["out/out_0001.code.json", 238], ["planning_state.json", 1471], ["run_state.json", 97], ["result/result.xlsx", 14380], ["result/result.csv", 1998], ["items/seg_0001.jsonl", 900],
];
const SECRET_MARK = "COMMENTER-NAME-و-TEXT-MUST-NOT-BE-LOGGED";

const h = vi.hoisted(() => ({
  admin: true as boolean,
  objects: new Map<string, Uint8Array>() as Map<string, Uint8Array>,
  /** extra names a hostile or broken listing returns inside a folder */
  hostileNames: new Map<string, Array<{ name: string; id: string | null; metadata: Record<string, unknown> | null }>>(),
  downloads: [] as string[],
  lists: [] as string[],
  writes: [] as string[],
  dbTouched: 0,
  buckets: [] as string[],
}));

vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async (req: Request) => {
    const header = req.headers.get("authorization") || "";
    if (!header) return { ok: false, response: new Response(JSON.stringify({ error: "غير مصرح." }), { status: 401, headers: { "content-type": "application/json" } }) };
    if (!h.admin || header !== "Bearer admin") return { ok: false, response: new Response(JSON.stringify({ error: "ممنوع" }), { status: 403, headers: { "content-type": "application/json" } }) };
    return { ok: true, ctx: { adminId: "a1", audit: async () => undefined } };
  }),
}));

/** A stand-in for the server's Storage client: list() is one folder level (as Supabase Storage lists), download() returns a Blob; every write throws. */
function fakeClient() {
  const write = (m: string) => () => { h.writes.push(m); throw new Error("the raw ZIP must never write"); };
  return {
    from: () => { h.dbTouched += 1; throw new Error("the raw ZIP must not touch a table"); },
    rpc: () => { h.dbTouched += 1; throw new Error("no rpc"); },
    storage: {
      from: (bucket: string) => {
        h.buckets.push(bucket);
        return {
          list: async (prefix: string, opts: { limit?: number; offset?: number } = {}) => {
            h.lists.push(prefix);
            const base = `${prefix.replace(/\/$/, "")}/`;
            const seen = new Map<string, { name: string; id: string | null; metadata: Record<string, unknown> | null }>();
            for (const [path, bytes] of h.objects) {
              if (!path.startsWith(base)) continue;
              const rest = path.slice(base.length);
              const [head, ...tail] = rest.split("/");
              if (tail.length > 0) seen.set(head, { name: head, id: null, metadata: null });
              else seen.set(head, { name: head, id: `id-${path}`, metadata: { size: bytes.byteLength, mimetype: "application/json" } });
            }
            const all = [...seen.values(), ...(h.hostileNames.get(prefix) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
            const offset = opts.offset ?? 0;
            const limit = opts.limit ?? 100;
            return { data: all.slice(offset, offset + limit), error: null };
          },
          download: async (path: string) => {
            h.downloads.push(path);
            const bytes = h.objects.get(path);
            if (!bytes) return { data: null, error: { message: "Object not found" } };
            return { data: new Blob([bytes]), error: null };
          },
          upload: write("upload"), update: write("update"), remove: write("remove"), move: write("move"), copy: write("copy"),
          createSignedUrl: write("createSignedUrl"), createSignedUrls: write("createSignedUrls"), createSignedUploadUrl: write("createSignedUploadUrl"),
        };
      },
    },
  };
}
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => fakeClient(), createServerSideClient: vi.fn() }));
vi.mock("../src/components/admin/AdminShell", () => ({ useAdmin: () => ({ toast: () => undefined }) }));

import { GET } from "../src/app/api/admin/agent/raw-zip/route";
import { RAW_ZIP_MAX_MISSIONS, RAW_ZIP_MAX_TOTAL_BYTES, isAllowedObjectPath, parseMissionIds, prepareRawZip } from "../src/lib/agentMission/rawZip";
import AgentPage from "../src/app/admin/agent/page";

/** Bytes of a given size whose content carries a marker (to prove no log line ever holds content). */
function bytesOf(size: number): Uint8Array {
  const out = new Uint8Array(size);
  const mark = new TextEncoder().encode(SECRET_MARK);
  for (let i = 0; i < size; i++) out[i] = mark[i % mark.length];
  return out;
}
function putMission(id: string, raw: Array<[string, number]>, rows: Array<[string, number]>, other: Array<[string, number]> = []) {
  for (const [n, s] of raw) h.objects.set(`${id}/raw/${n}`, bytesOf(s));
  for (const [n, s] of rows) h.objects.set(`${id}/rows/${n}`, bytesOf(s));
  for (const [n, s] of other) h.objects.set(`${id}/${n}`, bytesOf(s));
}
const get = (ids: string | null, headers: Record<string, string> = { authorization: "Bearer admin" }) =>
  GET(new NextRequest(`http://x/api/admin/agent/raw-zip${ids === null ? "" : `?ids=${encodeURIComponent(ids)}`}`, { headers }));
async function unzip(res: Response): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await res.arrayBuffer()));
}
const hexId = (n: number) => `msn_${n.toString(16).padStart(20, "0")}`;

let logs: unknown[][] = [];
beforeEach(() => {
  h.admin = true; h.objects.clear(); h.hostileNames.clear(); h.downloads = []; h.lists = []; h.writes = []; h.dbTouched = 0; h.buckets = [];
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a); });
  putMission(M17, M17_RAW_SIZES, M17_ROWS_SIZES, M17_OTHER);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("raw-zip: who may call it", () => {
  it("refuses a caller with no session (401) and a signed-in non-admin (403), and reads nothing", async () => {
    const anon = await get(M17, {});
    expect(anon.status).toBe(401);
    h.admin = false;
    const user = await get(M17, { authorization: "Bearer user" });
    expect(user.status).toBe(403);
    expect(h.lists).toEqual([]);
    expect(h.downloads).toEqual([]);
    expect(anon.headers.get("Cache-Control")).toBe("no-store");
    expect(user.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("raw-zip: the mission ids", () => {
  it("accepts only msn_ plus exactly 20 lowercase hex characters, one to forty of them", () => {
    expect(parseMissionIds(`${M17}, ${M19}\n${M17}`)).toEqual({ ok: true, ids: [M17, M19] });
    for (const bad of ["", "   ", "msn_6bb78c15d116268b0b9", "msn_6bb78c15d116268b0b9b0", "MSN_6bb78c15d116268b0b9b", "msn_6BB78C15D116268B0B9B", "msn_6bb78c15d116268b0b9g", `${M17}/raw`, "msn_../../../etc/passwd", "../msn_6bb78c15d116268b0b9b", "msn_6bb78c15d116268b0b9b%2F..", "job_6bb78c15d116268b0b9b"]) {
      expect(parseMissionIds(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseMissionIds(`${M17},bad`).ok).toBe(false);
    expect(RAW_ZIP_MAX_MISSIONS).toBe(40);
    expect(parseMissionIds(Array.from({ length: 40 }, (_, i) => hexId(i)).join(",")).ok).toBe(true);
    expect(parseMissionIds(Array.from({ length: 41 }, (_, i) => hexId(i)).join(",")).ok).toBe(false);
  });

  it("the route refuses a bad id, a missing list and more than forty ids with 400, before any Storage read", async () => {
    for (const bad of [null, "", "msn_123", `${M17},msn_../../x`, "../../agent-missions"]) {
      const res = await get(bad);
      expect(res.status, String(bad)).toBe(400);
      const body = await res.json();
      expect(typeof body.error).toBe("string");
    }
    const many = await get(Array.from({ length: 41 }, (_, i) => hexId(i)).join(","));
    expect(many.status).toBe(400);
    expect(h.lists).toEqual([]);
    expect(h.downloads).toEqual([]);
  });
});

describe("raw-zip: only raw/ and rows/, and no way out of them", () => {
  it("lists only <id>/raw and <id>/rows, in the bucket agent-missions, and downloads only their files", async () => {
    const res = await get(M17);
    expect(res.status).toBe(200);
    const files = await unzip(res);
    const names = Object.keys(files).filter((n) => n !== "manifest.json");
    expect(names.every((n) => n.startsWith(`${M17}/raw/`) || n.startsWith(`${M17}/rows/`))).toBe(true);
    for (const [n] of M17_OTHER) expect(names).not.toContain(`${M17}/${n}`);
    expect(names.some((n) => /result|planning_state|run_state|\/out\/|\/items\//.test(n))).toBe(false);
    expect([...new Set(h.lists)].sort()).toEqual([`${M17}/raw`, `${M17}/rows`]);
    expect(h.downloads.every((p) => /^msn_[0-9a-f]{20}\/(raw|rows)\/[A-Za-z0-9._-]+$/.test(p))).toBe(true);
    expect(new Set(h.buckets)).toEqual(new Set(["agent-missions"]));
  });

  it("a name the listing returns that is a folder, a dot name, or carries a slash or '..' is skipped and never downloaded", async () => {
    h.hostileNames.set(`${M17}/raw`, [
      { name: "../result/result.xlsx", id: "x1", metadata: { size: 10 } },
      { name: "..", id: "x2", metadata: { size: 10 } },
      { name: ".", id: "x3", metadata: { size: 10 } },
      { name: "a/b.json", id: "x4", metadata: { size: 10 } },
      { name: "..%2Fplanning_state.json", id: "x5", metadata: { size: 10 } },
      { name: "nested", id: null, metadata: null },
      { name: "call\\0099.json", id: "x6", metadata: { size: 10 } },
    ]);
    const res = await get(M17);
    expect(res.status).toBe(200);
    const names = Object.keys(await unzip(res));
    expect(names.some((n) => n.includes("..") || n.includes("result") || n.includes("nested") || n.includes("\\") || n.includes("%"))).toBe(false);
    expect(h.downloads.some((p) => p.includes("..") || p.includes("result") || p.includes("%"))).toBe(false);
    for (const bad of [`${M17}/raw/../result/result.xlsx`, `${M17}/raw/..`, `${M17}/run_state.json`, `${M17}/result/result.csv`, `${M17}/raw/a/b.json`, `msn_x/raw/a.json`, `/${M17}/raw/a.json`, `${M17}/raw/`, `${M17}/rows/.hidden`]) {
      expect(isAllowedObjectPath(bad), bad).toBe(false);
    }
    expect(isAllowedObjectPath(`${M17}/raw/call_0001.json`)).toBe(true);
    expect(isAllowedObjectPath(`${M17}/rows/comments_replies.json`)).toBe(true);
  });
});

describe("raw-zip: acceptance against the real metadata of M17", () => {
  it("the ZIP holds raw/call_0001.json ... raw/call_0013.json with the sizes of storage.objects, and the three rows files", async () => {
    const res = await get(M17);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="diger-raw-pages-[0-9]{8}-[0-9]{4}\.zip"$/);
    const files = await unzip(res);
    const raw = Object.entries(files).filter(([n]) => n.startsWith(`${M17}/raw/`)).map(([n, b]) => [n.slice(`${M17}/raw/`.length), b.byteLength]);
    expect(raw).toEqual(M17_RAW_SIZES);
    const rows = Object.entries(files).filter(([n]) => n.startsWith(`${M17}/rows/`)).map(([n, b]) => [n.slice(`${M17}/rows/`.length), b.byteLength]);
    expect(rows).toEqual(M17_ROWS_SIZES);
    // the bytes are the stored bytes, unchanged
    expect(files[`${M17}/raw/call_0004.json`]).toEqual(h.objects.get(`${M17}/raw/call_0004.json`));
    // the manifest is written last and holds names and sizes only, never content
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    expect(Object.keys(files).at(-1)).toBe("manifest.json");
    expect(manifest.missions).toEqual([{ id: M17, objects: 16, bytes: M17_RAW_SIZES.concat(M17_ROWS_SIZES).reduce((s, [, b]) => s + b, 0) }]);
    expect(manifest.files.slice(0, 13)).toEqual(M17_RAW_SIZES.map(([n, b]) => ({ path: `${M17}/raw/${n}`, bytes: b })));
    expect(strFromU8(files["manifest.json"])).not.toContain(SECRET_MARK);
  });

  it("several missions in one ZIP, in the order given; a mission with no stored objects is named in the manifest with 0", async () => {
    putMission(M19, [["call_0001.json", 714], ["call_0002.json", 5169]], [["posts.json", 1135]]);
    const empty = hexId(7);
    const res = await get(`${M19},${M17},${empty}`);
    expect(res.status).toBe(200);
    const files = await unzip(res);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    expect(manifest.missions.map((m: { id: string }) => m.id)).toEqual([M19, M17, empty]);
    expect(manifest.missions[2]).toEqual({ id: empty, objects: 0, bytes: 0 });
    expect(Object.keys(files).indexOf(`${M19}/raw/call_0001.json`)).toBeLessThan(Object.keys(files).indexOf(`${M17}/raw/call_0001.json`));
  });

  it("no mission with any stored raw/ or rows/ object: 404 with an Arabic message, no ZIP", async () => {
    const res = await get(hexId(9));
    expect(res.status).toBe(404);
    expect(String((await res.json()).error)).toMatch(/[؀-ۿ]/);
  });
});

describe("raw-zip: size guard, read-only, nothing secret, no content in any log", () => {
  it("refuses with 413 BEFORE any download when the listed sizes exceed the cap", async () => {
    const r = await prepareRawZip(fakeClient().storage, [M17], { maxTotalBytes: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(413); expect(r.error).toMatch(/[؀-ۿ]/); }
    expect(h.downloads).toEqual([]);
    expect(RAW_ZIP_MAX_TOTAL_BYTES).toBeGreaterThan(673_085 * 40);
    expect(RAW_ZIP_MAX_TOTAL_BYTES).toBeLessThanOrEqual(100 * 1024 * 1024);
  });

  it("an object larger on download than its listing said is cut off: the stream errors, the ZIP never completes", async () => {
    const r = await prepareRawZip(fakeClient().storage, [M17], { maxObjectBytes: 10_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
    // a lying listing (size 1) for a real 66,738-byte object: the download check catches it
    h.objects.set(`${M17}/raw/call_0004.json`, bytesOf(66738));
    const lying = fakeClient().storage;
    const origFrom = lying.from;
    lying.from = (b: string) => { const api = origFrom(b); const list = api.list; api.list = async (p: string, o?: any) => { const res = await list(p, o); return { ...res, data: res.data.map((x: any) => (x.metadata ? { ...x, metadata: { ...x.metadata, size: 1 } } : x)) }; }; return api; };
    const p = await prepareRawZip(lying, [M17], { maxObjectBytes: 10_000 });
    expect(p.ok).toBe(true);
    if (p.ok) await expect(new Response(p.stream).arrayBuffer()).rejects.toBeTruthy();
  });

  it("writes nothing anywhere, touches no table, and logs only the mission id, the object count and the bytes", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sk-test-service-role-NEVER-IN-OUTPUT";
    const res = await get(M17);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(h.writes).toEqual([]);
    expect(h.dbTouched).toBe(0);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(SECRET_MARK);
    expect(text).not.toContain("sk-test-service-role");
    expect(logs.some((a) => a.join(" ").includes(M17))).toBe(true);
    for (const a of logs) expect(a.join(" ")).toMatch(/^raw-zip mission=msn_[0-9a-f]{20} objects=\d+ bytes=\d+$/);
    const headerText = JSON.stringify([...res.headers.entries()]);
    expect(headerText).not.toContain("sk-test-service-role");
    expect(strFromU8(bytes, true)).not.toContain("sk-test-service-role");
  });

  it("the route uses the server's existing admin client and adds no environment variable", () => {
    const route = readFileSync("src/app/api/admin/agent/raw-zip/route.ts", "utf8");
    const lib = readFileSync("src/lib/agentMission/rawZip.ts", "utf8");
    expect(route).toContain("authenticateAdmin");
    expect(route).toContain("createAdminClient");
    for (const src of [route, lib]) {
      expect(src).not.toMatch(/process\.env/);
      expect(src).not.toMatch(/\.(upload|remove|move|copy|update|createSignedUrl)\s*\(/);
    }
    expect(readFileSync(".gitignore", "utf8")).toMatch(/diger-raw-pages-\*\.zip/);
  });
});

describe("raw-zip: the admin agent page", () => {
  it("has one text box for mission ids and one download button, in Arabic, with no provider name and no dollar sign", () => {
    const html = renderToStaticMarkup(createElement(AgentPage));
    expect(html).toContain('data-testid="agent-raw-zip-ids"');
    expect(html).toContain('data-testid="agent-raw-zip"');
    const section = /<section[^>]*data-testid="agent-raw-zip-section"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? "";
    expect(section).not.toBe("");
    const visible = section.replace(/<[^>]+>/g, " ");
    expect(visible).toMatch(/[؀-ۿ]/);
    expect(visible).not.toMatch(/treg|anyapi|tikhub|crawl4ai|scrapecreators|justoneapi|USD|\$/i);
    expect(visible).not.toMatch(/[0-9]/);
    const page = readFileSync("src/app/admin/agent/page.tsx", "utf8");
    expect(page).toContain("/api/admin/agent/raw-zip?ids=");
    expect(page).toContain("adminDownload");
  });
});
