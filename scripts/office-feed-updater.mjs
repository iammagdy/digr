#!/usr/bin/env node
/**
 * Non-AI server updater for diger.tech/office live team status feed (D-0151, DT-20261121-office-v2).
 * Reads sanitized JSONL status lines written by bots under OFFICE_STATUS_DIR,
 * reads task status.md under OFFICE_TASKS_DIR,
 * checks file mtime activity under bot work directories,
 * merges open GitHub PR count from the public repo API (cached via ETag),
 * applies explicit state rules (waiting silent 2h is waiting, not stuck; working inactive > 45 min is stuck),
 * abstracts internal details into generic activity types with no internal task/branch/PR IDs,
 * and uploads status.json.
 * Zero AI calls, zero customer data, zero hardcoded secrets.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CANONICAL_BOTS = [
  "elkebir",
  "johnny",
  "nafady",
  "hagras",
  "salem",
  "hazalqom",
  "fazza",
  "ashraf",
  "marbouha",
];

export const BOT_ROLES = {
  elkebir: "المدير التقني وقائد الفريق",
  johnny: "المعماري (خطط وكود الفلوس)",
  nafady: "المعماري التاني (الشغل اللي مش فلوس)",
  hagras: "المنفّذ الأول",
  salem: "المنفّذ التاني",
  hazalqom: "المصمم",
  fazza: "صائد الأخطاء (الفلوس والمشاكل الخطيرة)",
  ashraf: "صائد الأخطاء التاني",
  marbouha: "الجودة والاختبار",
};

export const DEFAULT_BOT_WORK_DIRS = {
  elkebir: "/srv/diger-team/commander",
  johnny: "/srv/diger-team/architect/work",
  nafady: "/srv/diger-team/architect2/work",
  hagras: "/srv/diger-team/fawaaly/work",
  salem: "/srv/diger-team/fawaaly2/work",
  hazalqom: "/srv/diger-team/designer/work",
  fazza: "/srv/diger-team/bughunter/work",
  ashraf: "/srv/diger-team/bughunter2/work",
  marbouha: "/srv/diger-team/qa/work",
};

export const STALE_AFTER_MINUTES = 45;
export const STALE_AFTER_MS = STALE_AFTER_MINUTES * 60 * 1000;

function clampPercent(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeIsoUtc(ts) {
  if (typeof ts !== "string" || !ts.trim()) return null;
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function getNewestFileMtime(dirPath, maxDepth = 2) {
  if (!dirPath || typeof dirPath !== "string") return 0;
  let newest = 0;
  function scan(currentDir, currentDepth) {
    if (currentDepth > maxDepth) return;
    try {
      if (!fs.existsSync(currentDir)) return;
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
        const fullPath = path.join(currentDir, ent.name);
        try {
          const st = fs.statSync(fullPath);
          if (st.isFile()) {
            if (st.mtimeMs > newest) newest = st.mtimeMs;
          } else if (st.isDirectory()) {
            scan(fullPath, currentDepth + 1);
          }
        } catch {
          // ignore unreadable file
        }
      }
    } catch {
      // ignore unreadable directory
    }
  }
  scan(dirPath, 0);
  return newest;
}

export function readTaskStatus(tasksDir, taskId) {
  if (!tasksDir || !taskId || typeof taskId !== "string") return null;
  const cleanId = path.basename(taskId.trim());
  const statusFile = path.join(tasksDir, cleanId, "status.md");
  try {
    if (!fs.existsSync(statusFile)) return null;
    const content = fs.readFileSync(statusFile, "utf8");
    let state = null;
    let percent = null;
    const stateMatch = content.match(/^state:\s*([a-zA-Z_-]+)/m);
    if (stateMatch) {
      state = stateMatch[1].trim().toLowerCase();
    }
    const percentMatch = content.match(/^percent:\s*(\d+)/m);
    if (percentMatch) {
      percent = clampPercent(percentMatch[1]);
    }
    return { state, percent };
  } catch {
    return null;
  }
}

export function parseBotJsonl(rawText, botId) {
  if (!rawText || typeof rawText !== "string") {
    return { latest: null, recent: [] };
  }
  const entries = [];
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && (!obj.bot || obj.bot === botId)) {
        entries.push(obj);
      }
    } catch {
      // Ignore malformed line
    }
  }
  if (entries.length === 0) return { latest: null, recent: [] };

  const latest = entries[entries.length - 1];
  return { latest, recent: [] };
}

export function resolveActivityType(botId, state) {
  if (state === "waiting") return "في انتظار الفحص الآلي";
  if (state === "meeting") return "في اجتماع فني";
  if (state === "idle") return "استراحة قصيرة / متاح";
  switch (botId) {
    case "elkebir":
      return "متابعة وإشراف تقني";
    case "johnny":
    case "nafady":
    case "fazza":
    case "ashraf":
      return "مراجعة فنية ومعمارية";
    case "hagras":
    case "salem":
      return "تطوير وكتابة كود";
    case "marbouha":
      return "فحص جودة واختبارات";
    case "hazalqom":
      return "تصميم واجهات وتجربة";
    default:
      return "تطوير ومتابعة فنية";
  }
}

/**
 * @param {{
 *   statusDir: string,
 *   tasksDir?: string,
 *   workDirs?: Record<string, string>,
 *   openPrs?: number | Array<{ number: number, title?: string }>,
 *   nowMs?: number
 * }} opts
 */
export function buildOfficeFeed({
  statusDir,
  tasksDir = process.env.OFFICE_TASKS_DIR || "/srv/diger-team/commander/tasks",
  workDirs = DEFAULT_BOT_WORK_DIRS,
  openPrs = [],
  nowMs = Date.now(),
}) {
  const bots = {};

  for (const botId of CANONICAL_BOTS) {
    const filePath = path.join(statusDir, `${botId}.jsonl`);
    let raw = "";
    try {
      if (fs.existsSync(filePath)) {
        raw = fs.readFileSync(filePath, "utf8");
      }
    } catch {
      raw = "";
    }

    const { latest } = parseBotJsonl(raw, botId);
    const role = BOT_ROLES[botId] || "";

    if (!latest) {
      bots[botId] = {
        bot: botId,
        role,
        state: "idle",
        activity_type: resolveActivityType(botId, "idle"),
        percent: null,
        last_active: null,
        updated_at: null,
      };
      continue;
    }

    const updatedAt = normalizeIsoUtc(latest.updated_at);
    const jsonlUpdatedMs = updatedAt ? Date.parse(updatedAt) : 0;
    const workDir = (workDirs && workDirs[botId]) || DEFAULT_BOT_WORK_DIRS[botId];
    const folderMtimeMs = getNewestFileMtime(workDir);
    const lastActiveMs = Math.max(jsonlUpdatedMs, folderMtimeMs);
    const lastActiveIso =
      lastActiveMs > 0
        ? new Date(lastActiveMs).toISOString().replace(/\.\d{3}Z$/, "Z")
        : updatedAt || null;

    const taskId = latest.task_id ? String(latest.task_id).trim() : null;
    const taskStatus = taskId ? readTaskStatus(tasksDir, taskId) : null;

    // 1. Determine percent (CTO correction 3)
    let percent = null;
    if (taskId) {
      if (taskStatus && taskStatus.percent !== null) {
        percent = taskStatus.percent;
      } else if (latest.percent !== undefined && latest.percent !== null) {
        percent = clampPercent(latest.percent);
      }
    }

    // 2. Determine base state (CTO correction 2)
    let baseState = "idle";
    const explicitTaskState = taskStatus?.state;
    const rawJsonlState = String(latest.state || "idle").toLowerCase();

    if (explicitTaskState === "waiting" || (!explicitTaskState && rawJsonlState === "waiting")) {
      baseState = "waiting";
    } else if (explicitTaskState === "meeting" || (!explicitTaskState && rawJsonlState === "meeting")) {
      baseState = "meeting";
    } else if (explicitTaskState === "done") {
      baseState = "idle";
    } else if (explicitTaskState === "working") {
      baseState = "working";
    } else if (rawJsonlState === "working" || rawJsonlState === "stuck" || latest.open_order) {
      baseState = "working";
    } else {
      baseState = "idle";
    }

    // 3. Resolve final state (CTO correction 2)
    let state = baseState;
    if (baseState === "waiting") {
      state = "waiting";
    } else if (baseState === "meeting") {
      state = "meeting";
    } else if (baseState === "idle") {
      state = "idle";
    } else if (baseState === "working") {
      const isStale =
        !Number.isFinite(lastActiveMs) ||
        lastActiveMs <= 0 ||
        nowMs - lastActiveMs > STALE_AFTER_MS;
      state = isStale ? "stuck" : "working";
    }

    const activityType = resolveActivityType(botId, state);

    bots[botId] = {
      bot: botId,
      role,
      state,
      activity_type: activityType,
      percent,
      last_active: lastActiveIso,
      updated_at: lastActiveIso,
    };
  }

  const prCount = Array.isArray(openPrs)
    ? openPrs.length
    : Number.isFinite(Number(openPrs))
    ? Math.max(0, Math.floor(Number(openPrs)))
    : 0;

  return {
    version: 1,
    generated_at: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    stale_after_minutes: STALE_AFTER_MINUTES,
    open_prs: prCount,
    bots,
  };
}

export async function fetchOpenPrs({
  repo = "iammagdy/digr",
  cachePath = "/tmp/diger-office-prs-cache.json",
  nowMs = Date.now(),
  minIntervalMs = 180_000,
  fetchImpl = globalThis.fetch,
} = {}) {
  let cached = { fetchedAt: 0, etag: "", count: 0 };
  try {
    if (cachePath && fs.existsSync(cachePath)) {
      cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) || cached;
    }
  } catch {
    cached = { fetchedAt: 0, etag: "", count: 0 };
  }

  if (nowMs - (cached.fetchedAt || 0) < minIntervalMs && typeof cached.count === "number") {
    return cached.count;
  }

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "diger-office-feed-updater",
  };
  if (cached.etag) headers["If-None-Match"] = cached.etag;

  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=1`, { headers });
    if (res.status === 304) {
      cached.fetchedAt = nowMs;
      if (cachePath) fs.writeFileSync(cachePath, JSON.stringify(cached), "utf8");
      return cached.count || 0;
    }
    if (!res.ok) return cached.count || 0;
    const linkHeader = res.headers.get("link") || "";
    let totalCount = 0;
    const lastMatch = linkHeader.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/);
    if (lastMatch) {
      totalCount = parseInt(lastMatch[1], 10);
    } else {
      const data = await res.json();
      totalCount = Array.isArray(data) ? data.length : 0;
    }
    const nextCache = {
      fetchedAt: nowMs,
      etag: res.headers.get("etag") || "",
      count: totalCount,
    };
    if (cachePath) fs.writeFileSync(cachePath, JSON.stringify(nextCache), "utf8");
    return totalCount;
  } catch {
    return cached.count || 0;
  }
}

export async function uploadFeed({ feedJson, uploadUrl, uploadKey, fetchImpl = globalThis.fetch }) {
  if (!uploadUrl || !uploadKey) {
    throw new Error("Missing OFFICE_UPLOAD_URL or OFFICE_UPLOAD_KEY");
  }
  const body = typeof feedJson === "string" ? feedJson : JSON.stringify(feedJson);
  const res = await fetchImpl(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${uploadKey}`,
      apikey: uploadKey,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=15, s-maxage=15",
      "x-upsert": "true",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Upload failed with HTTP ${res.status}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const isDryRun = argv.includes("--dry-run");
  const statusDir = process.env.OFFICE_STATUS_DIR || "/srv/diger-team/shared/office-status";
  const tasksDir = process.env.OFFICE_TASKS_DIR || "/srv/diger-team/commander/tasks";
  const repo = process.env.OFFICE_GITHUB_REPO || "iammagdy/digr";
  const uploadUrl = process.env.OFFICE_UPLOAD_URL || "";
  const uploadKey = process.env.OFFICE_UPLOAD_KEY || "";
  const cachePath = process.env.OFFICE_PR_CACHE_PATH || "/tmp/diger-office-prs-cache.json";

  const openPrCount = await fetchOpenPrs({ repo, cachePath });
  const feed = buildOfficeFeed({ statusDir, tasksDir, openPrs: openPrCount });

  if (isDryRun) {
    console.log(JSON.stringify(feed, null, 2));
    return;
  }

  await uploadFeed({ feedJson: feed, uploadUrl, uploadKey });
  console.log(`office-feed-updated bots=${Object.keys(feed.bots).length} prs=${feed.open_prs} at=${feed.generated_at}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("office-feed-error:", err instanceof Error ? err.message : "unknown");
    process.exit(1);
  });
}
