#!/usr/bin/env node
/**
 * Non-AI server updater for provider updates feed (D-0200).
 * Reads updates.jsonl from shared feed directory,
 * bundles markdown reports from reports directory,
 * builds canonical payload { version: 1, generated_at, total, updates, reports },
 * and uploads to private Supabase Storage via Edge Function (?target=provider-updates).
 * Zero AI calls, zero customer data, zero hardcoded secrets.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_UPDATES_FILE = "/srv/diger-team/shared/provider-updates/updates.jsonl";
export const DEFAULT_REPORTS_DIR = "/srv/diger-team/shared/provider-updates/reports";

/**
 * Builds the canonical provider updates feed payload from JSONL lines and report files.
 */
export function buildProviderUpdatesFeed({
  updatesPath = DEFAULT_UPDATES_FILE,
  reportsDir = DEFAULT_REPORTS_DIR,
} = {}) {
  const updates = [];
  const reports = {};

  if (fs.existsSync(updatesPath)) {
    const rawContent = fs.readFileSync(updatesPath, "utf-8");
    const lines = rawContent.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
          updates.push(parsed);

          // Resolve and read markdown report if report_path is specified
          let reportText = null;
          if (parsed.report_path && fs.existsSync(parsed.report_path)) {
            try {
              reportText = fs.readFileSync(parsed.report_path, "utf-8");
            } catch {
              reportText = null;
            }
          } else if (reportsDir) {
            const fallbackReportPath = path.join(reportsDir, `${parsed.id}.md`);
            if (fs.existsSync(fallbackReportPath)) {
              try {
                reportText = fs.readFileSync(fallbackReportPath, "utf-8");
              } catch {
                reportText = null;
              }
            }
          }

          if (typeof reportText === "string") {
            reports[parsed.id] = reportText;
          }
        }
      } catch {
        // Silently skip corrupted or malformed lines without crashing
      }
    }
  }

  // Sort updates newest first by date and id
  updates.sort((a, b) => {
    const cmp = (b.date || "").localeCompare(a.date || "");
    return cmp !== 0 ? cmp : (b.id || "").localeCompare(a.id || "");
  });

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    total: updates.length,
    updates,
    reports,
  };
}

/**
 * Uploads the canonical feed payload to private storage via Edge Function.
 */
export async function uploadFeed({
  feedJson,
  uploadUrl,
  uploadKey,
  fetchImpl = globalThis.fetch,
}) {
  if (!uploadUrl || !uploadKey) {
    throw new Error("Missing uploadUrl or uploadKey");
  }

  // Ensure ?target=provider-updates is included
  let targetUrl = uploadUrl;
  if (!targetUrl.includes("target=provider-updates")) {
    targetUrl += (targetUrl.includes("?") ? "&" : "?") + "target=provider-updates";
  }

  const body = typeof feedJson === "string" ? feedJson : JSON.stringify(feedJson);

  const res = await fetchImpl(targetUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${uploadKey}`,
      apikey: uploadKey,
      "Content-Type": "application/json",
      "Cache-Control": "private, no-cache",
      "x-upsert": "true",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Upload failed with HTTP ${res.status}`);
  }

  return { ok: true, status: res.status };
}

export async function main(argv = process.argv.slice(2)) {
  const isDryRun = argv.includes("--dry-run");
  const updatesPath = process.env.PROVIDER_UPDATES_FILE || DEFAULT_UPDATES_FILE;
  const reportsDir = process.env.PROVIDER_REPORTS_DIR || DEFAULT_REPORTS_DIR;
  const uploadUrl = process.env.OFFICE_UPLOAD_URL || "";
  const uploadKey = process.env.OFFICE_UPLOAD_KEY || "";

  const feed = buildProviderUpdatesFeed({ updatesPath, reportsDir });

  if (isDryRun) {
    console.log(JSON.stringify(feed, null, 2));
    return;
  }

  await uploadFeed({ feedJson: feed, uploadUrl, uploadKey });
  console.log(`provider-updates-feed-updated total=${feed.total} at=${feed.generated_at}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("provider-updates-feed-error:", err instanceof Error ? err.message : "unknown");
    process.exit(1);
  });
}
