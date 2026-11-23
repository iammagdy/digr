#!/usr/bin/env node
/**
 * Non-AI server updater for provider updates feed (D-0200).
 * Reads updates.jsonl from specified feed file or PROVIDER_UPDATES_FILE env,
 * bundles markdown reports from specified reports dir or PROVIDER_REPORTS_DIR env,
 * builds canonical payload { version: 1, generated_at, total, updates, reports },
 * and uploads to private Supabase Storage via Edge Function (?target=provider-updates).
 * Zero AI calls, zero customer data, zero hardcoded secrets.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Parses CLI arguments and falls back to environment variables.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  let updatesPath = process.env.PROVIDER_UPDATES_FILE || "";
  let reportsDir = process.env.PROVIDER_REPORTS_DIR || "";
  let isDryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      isDryRun = true;
    } else if (arg.startsWith("--updates=")) {
      updatesPath = arg.slice("--updates=".length);
    } else if (arg === "--updates" && i + 1 < argv.length) {
      updatesPath = argv[++i];
    } else if (arg.startsWith("--reports=")) {
      reportsDir = arg.slice("--reports=".length);
    } else if (arg === "--reports" && i + 1 < argv.length) {
      reportsDir = argv[++i];
    }
  }

  return { updatesPath, reportsDir, isDryRun };
}

/**
 * Builds the canonical provider updates feed payload from JSONL lines and report files.
 */
export function buildProviderUpdatesFeed({
  updatesPath = process.env.PROVIDER_UPDATES_FILE || "",
  reportsDir = process.env.PROVIDER_REPORTS_DIR || "",
} = {}) {
  if (!updatesPath) {
    throw new Error(
      "Missing updates file path. Provide via --updates <path> or PROVIDER_UPDATES_FILE environment variable."
    );
  }
  if (!reportsDir) {
    throw new Error(
      "Missing reports directory. Provide via --reports <dir> or PROVIDER_REPORTS_DIR environment variable."
    );
  }

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

          // Resolve and read markdown report if report_path is specified and exists, or fallback to reportsDir
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
  const { updatesPath, reportsDir, isDryRun } = parseArgs(argv);
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
