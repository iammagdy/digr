import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ProviderUpdatesFeedPayload } from "@/components/admin/providerUpdates/types";
import {
  buildProviderUpdatesFeed,
  uploadFeed,
  parseArgs,
} from "../scripts/provider-updates-feed-updater.mjs";
import {
  handleOfficeFeedRequest,
  PRIVATE_INTERNAL_BUCKET,
  PROVIDER_UPDATES_OBJECT_PATH,
  OFFICE_BUCKET,
  OFFICE_OBJECT_PATH,
} from "../supabase/functions/office-feed/handler";

const FIXTURES_DIR = path.resolve(__dirname, "fixtures/provider-updates");
const FIXTURE_UPDATES_FILE = path.join(FIXTURES_DIR, "updates.jsonl");
const FIXTURE_REPORTS_DIR = path.join(FIXTURES_DIR, "reports");

const TOKEN = "tok_test_feed_key_12345";
const SERVICE_KEY = "svc_test_service_key_67890";
const SUPABASE_URL = "https://mock.supabase.co";

function makeEnv() {
  return {
    feedToken: TOKEN,
    supabaseUrl: SUPABASE_URL,
    serviceKey: SERVICE_KEY,
  };
}

describe("Provider Updates Feed Pipeline (D-0200)", () => {
  it("ingests 7 fixture records, bundles markdown reports, and sorts newest first", () => {
    const feed: ProviderUpdatesFeedPayload = buildProviderUpdatesFeed({
      updatesPath: FIXTURE_UPDATES_FILE,
      reportsDir: FIXTURE_REPORTS_DIR,
    }) as ProviderUpdatesFeedPayload;

    expect(feed.version).toBe(1);
    expect(feed.total).toBe(7);
    expect(feed.updates.length).toBe(7);

    // Verify reports were bundled for items
    expect(Object.keys(feed.reports).length).toBe(7);
    for (const update of feed.updates) {
      expect(feed.reports[update.id]).toBeDefined();
      expect(feed.reports[update.id].length).toBeGreaterThan(50);
    }

    // Verify newest first sorting
    for (let i = 1; i < feed.updates.length; i++) {
      const prevDate = feed.updates[i - 1].date;
      const currDate = feed.updates[i].date;
      expect(prevDate >= currDate).toBe(true);
    }
  });

  it("counter-case 1: skips corrupted or malformed JSONL lines silently", () => {
    const tempFile = path.join(FIXTURES_DIR, "temp-corrupted.jsonl");
    const content = [
      '{"id": "valid-1", "date": "2026-11-23", "provider": "treg", "item": "test", "kind": "new", "title_ar": "صالح", "brief_ar": "نص", "summary_ar": "ملخص", "price_ar": "مجاني", "source_url": "", "report_path": "", "status": "new"}',
      'CORRUPTED_NOT_JSON_LINE {{{',
      '{"id": "valid-2", "date": "2026-11-22", "provider": "firecrawl", "item": "test2", "kind": "changed", "title_ar": "صالح 2", "brief_ar": "نص 2", "summary_ar": "ملخص 2", "price_ar": "مجاني", "source_url": "", "report_path": "", "status": "studied"}',
      '',
    ].join("\n");

    try {
      fs.writeFileSync(tempFile, content, "utf-8");
      const feed: ProviderUpdatesFeedPayload = buildProviderUpdatesFeed({ updatesPath: tempFile, reportsDir: FIXTURE_REPORTS_DIR }) as ProviderUpdatesFeedPayload;
      expect(feed.total).toBe(2);
      expect(feed.updates.map((u) => u.id)).toEqual(["valid-1", "valid-2"]);
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });

  it("counter-case 2: gracefully handles missing report files without crashing", () => {
    const tempFile = path.join(FIXTURES_DIR, "temp-missing-report.jsonl");
    const content = '{"id": "missing-report-item", "date": "2026-11-23", "provider": "treg", "item": "test", "kind": "new", "title_ar": "صالح", "brief_ar": "نص", "summary_ar": "ملخص", "price_ar": "مجاني", "source_url": "", "report_path": "/nonexistent/path/missing.md", "status": "new"}\n';

    try {
      fs.writeFileSync(tempFile, content, "utf-8");
      const feed: ProviderUpdatesFeedPayload = buildProviderUpdatesFeed({ updatesPath: tempFile, reportsDir: "/nonexistent/reports" }) as ProviderUpdatesFeedPayload;
      expect(feed.total).toBe(1);
      expect(feed.reports["missing-report-item"]).toBeUndefined();
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });

  it("uploadFeed appends ?target=provider-updates and uploads to private storage", async () => {
    const capturedCalls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      capturedCalls.push({
        url,
        method: String(init?.method || "GET"),
        headers,
        body: String(init?.body || ""),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const feed = buildProviderUpdatesFeed({ updatesPath: FIXTURE_UPDATES_FILE, reportsDir: FIXTURE_REPORTS_DIR });
    const result = await uploadFeed({
      feedJson: feed,
      uploadUrl: "https://mock.supabase.co/functions/v1/office-feed",
      uploadKey: TOKEN,
      fetchImpl: mockFetch,
    });

    expect(result.ok).toBe(true);
    expect(capturedCalls.length).toBe(1);
    expect(capturedCalls[0].url).toBe("https://mock.supabase.co/functions/v1/office-feed?target=provider-updates");
    expect(capturedCalls[0].headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(capturedCalls[0].headers["x-upsert"]).toBe("true");
  });

  it("Edge Function writes to private storage office-internal/provider-updates.json when target=provider-updates", async () => {
    const storageDestinations: string[] = [];

    const mockStorageFetcher: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      storageDestinations.push(url);
      return new Response(JSON.stringify({ Key: `${PRIVATE_INTERNAL_BUCKET}/${PROVIDER_UPDATES_OBJECT_PATH}` }), { status: 200 });
    };

    const feed = buildProviderUpdatesFeed({ updatesPath: FIXTURE_UPDATES_FILE, reportsDir: FIXTURE_REPORTS_DIR });

    const req = new Request("https://mock.supabase.co/functions/v1/office-feed?target=provider-updates", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(feed),
    });

    const res = await handleOfficeFeedRequest(req, makeEnv(), { fetcher: mockStorageFetcher });
    expect(res.status).toBe(200);

    expect(storageDestinations.length).toBe(1);
    expect(storageDestinations[0]).toContain(`/storage/v1/object/${PRIVATE_INTERNAL_BUCKET}/${PROVIDER_UPDATES_OBJECT_PATH}`);
    expect(storageDestinations[0]).not.toContain(OFFICE_BUCKET);
  });

  it("Public Office Feed Isolation Guarantee: public office feed NEVER contains provider updates", async () => {
    const publicStorageDestinations: string[] = [];

    const mockStorageFetcher: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      publicStorageDestinations.push(url);
      return new Response(JSON.stringify({ Key: `${OFFICE_BUCKET}/${OFFICE_OBJECT_PATH}` }), { status: 200 });
    };

    const officeStatusPayload = {
      version: 1,
      generated_at: "2026-11-23T20:00:00Z",
      open_prs: 1,
      bots: {
        salem: { bot: "salem", state: "idle", task_title: "تحديثات المزودين", percent: 100 },
      },
    };

    const req = new Request("https://mock.supabase.co/functions/v1/office-feed", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(officeStatusPayload),
    });

    const res = await handleOfficeFeedRequest(req, makeEnv(), { fetcher: mockStorageFetcher });
    expect(res.status).toBe(200);

    // Verify it uploaded to public office-status, NOT private internal
    expect(publicStorageDestinations[0]).toContain(`/storage/v1/object/${OFFICE_BUCKET}/${OFFICE_OBJECT_PATH}`);
    expect(publicStorageDestinations[0]).not.toContain(PRIVATE_INTERNAL_BUCKET);

    // Verify public payload contains zero provider update items or reports
    const bodyStr = JSON.stringify(officeStatusPayload);
    expect(bodyStr).not.toContain("report_path");
    expect(bodyStr).not.toContain("price_ar");
    expect(bodyStr).not.toContain("brief_ar");
  });

  it("CLI args and env vars parsing for feed updater", () => {
    // CLI args with space
    const parsed1 = parseArgs(["--updates", "/custom/updates.jsonl", "--reports", "/custom/reports", "--dry-run"]);
    expect(parsed1.updatesPath).toBe("/custom/updates.jsonl");
    expect(parsed1.reportsDir).toBe("/custom/reports");
    expect(parsed1.isDryRun).toBe(true);

    // CLI args with =
    const parsed2 = parseArgs(["--updates=/eq/updates.jsonl", "--reports=/eq/reports"]);
    expect(parsed2.updatesPath).toBe("/eq/updates.jsonl");
    expect(parsed2.reportsDir).toBe("/eq/reports");
    expect(parsed2.isDryRun).toBe(false);

    // Env vars fallback
    const origUpdates = process.env.PROVIDER_UPDATES_FILE;
    const origReports = process.env.PROVIDER_REPORTS_DIR;
    try {
      process.env.PROVIDER_UPDATES_FILE = "/env/updates.jsonl";
      process.env.PROVIDER_REPORTS_DIR = "/env/reports";
      const parsedEnv = parseArgs([]);
      expect(parsedEnv.updatesPath).toBe("/env/updates.jsonl");
      expect(parsedEnv.reportsDir).toBe("/env/reports");
    } finally {
      process.env.PROVIDER_UPDATES_FILE = origUpdates;
      process.env.PROVIDER_REPORTS_DIR = origReports;
    }
  });

  it("fails with a clear error message when updates file or reports dir is missing", () => {
    const origUpdates = process.env.PROVIDER_UPDATES_FILE;
    const origReports = process.env.PROVIDER_REPORTS_DIR;
    try {
      delete process.env.PROVIDER_UPDATES_FILE;
      delete process.env.PROVIDER_REPORTS_DIR;

      expect(() => buildProviderUpdatesFeed({ updatesPath: "", reportsDir: "/some/dir" })).toThrow(
        /Missing updates file path/
      );
      expect(() => buildProviderUpdatesFeed({ updatesPath: "/some/file", reportsDir: "" })).toThrow(
        /Missing reports directory/
      );
    } finally {
      process.env.PROVIDER_UPDATES_FILE = origUpdates;
      process.env.PROVIDER_REPORTS_DIR = origReports;
    }
  });
});
