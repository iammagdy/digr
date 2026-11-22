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
export const MERGED_SINCE_ISO = "2026-11-20T00:00:00Z";
export const MAX_FEED_BYTES = 60_000;

export const BOT_ARABIC_NAMES = {
  elkebir: "الكبير",
  johnny: "جوني",
  nafady: "نفادي",
  hagras: "هجرس",
  salem: "سالم",
  hazalqom: "حزلقوم",
  fazza: "فزاع",
  ashraf: "أشرف",
  marbouha: "مربوحة",
};

const BOT_ALIASES = Object.entries(BOT_ARABIC_NAMES);
const BOT_ALIAS_MAP = new Map();
for (const [id, ar] of BOT_ALIASES) {
  BOT_ALIAS_MAP.set(id, id);
  BOT_ALIAS_MAP.set(ar, id);
}

export function cleanArabicTitle(raw) {
  if (!raw || typeof raw !== "string") return "";
  const cleaned = raw
    .replace(/^#+\s*/, "")
    .replace(/\b(?:DT-\d{8}(?:[-/][A-Za-z0-9._-]+)*|NEW-ISSUES-\d+|FX-[A-Za-z0-9-]+|O\d+-[A-Za-z0-9._-]+|PR\s*#?\d+|D-\d+)\b/gi, " ")
    .replace(/\/srv\/\S+|refs\/pull\/\S+|https?:\/\/\S+|\S+\.(?:ts|tsx|mjs|js|md|sql)\b/gi, " ")
    .replace(/\b(?:Gate\s*\d+|round\s*\d+|pre-push|check|plan|v\d+(?:\.\d+)?|MUST\s*\d+[-–]\d+|N\d+)\b/gi, " ")
    .replace(/توثيق المهمة\s*[:：]|توثيق تعديلات\s*/g, " ")
    .replace(/\([^()]*[A-Za-z][^()]*\)/g, " ")
    .replace(/(?:^|\s)الـ\s*[A-Za-z0-9._-]+/g, " ")
    .replace(/[A-Za-z0-9_.-]+/g, (tok) => (/^\d+$/.test(tok) ? tok : " "))
    .replace(/\bالـ(?=\s|$|[=+/،.:؛])/g, " ")
    .replace(/[()[\]`]+/g, " ")
    .replace(/\s+[+=]\s+/g, " ")
    .replace(/\s*[=+/]+\s*$/g, "")
    .replace(/^\s*[=+/]+\s*/g, "")
    .replace(/^[\s:：—–\-·•،/=]+|[\s:：—–\-·•،/=]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!/[\u0600-\u06FF]/.test(cleaned)) return "";
  if (/^(?:دمج|مراجعة|فحص|نشر|تحديث|إصلاح)$/.test(cleaned)) return "";
  return cleaned;
}

function isBoilerplateArabicTitle(title) {
  return /^(?:دمج|مراجعة|فحص|نشر|تشغيل|تم دفع)\b/.test(title);
}

function extractTaskKeys(text) {
  if (!text || typeof text !== "string") return [];
  const matches = text.match(/\b(?:DT-\d{8}(?:-[A-Za-z0-9._-]+)?|NEW-ISSUES-\d+)\b/gi) || [];
  const keys = [];
  for (const m of matches) {
    const norm = m.toLowerCase().replace(/\//g, "-");
    if (!keys.includes(norm)) keys.push(norm);
  }
  return keys;
}

function extractPrNumbers(text) {
  if (!text || typeof text !== "string") return [];
  const nums = new Set();
  const re = /(?:PR\s*#?|\/pull\/|#)(\d{2,5})\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) nums.add(n);
  }
  return Array.from(nums);
}

function extractBotsFromAttributionLines(text) {
  if (!text || typeof text !== "string") return [];
  const found = new Set();
  const lines = text.split(/\r?\n/).slice(0, 60);
  for (const line of lines) {
    if (!/(?:Implementer|المنفذ|المنفّذ|المراجع|المصمم|الجودة|المعماري|خطوات|Review|QA|مراجعة|الاعتماد)/i.test(line)) {
      continue;
    }
    for (const [id, ar] of BOT_ALIASES) {
      if (line.includes(ar) || new RegExp(`\\b${id}\\b`, "i").test(line)) {
        found.add(id);
      }
    }
  }
  return CANONICAL_BOTS.filter((id) => found.has(id));
}

function loadDocsIndex(docsDir) {
  const entries = [];
  if (!docsDir || typeof docsDir !== "string") return entries;
  try {
    if (!fs.existsSync(docsDir)) return entries;
  } catch {
    return entries;
  }

  function walk(dir, depth) {
    if (depth > 3) return;
    let list = [];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of list) {
      if (ent.name.startsWith(".")) continue;
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith(".md")) {
        const rel = path.relative(docsDir, fullPath).replace(/\\/g, "/");
        if (depth === 0 && ["DECISIONS.md", "LESSONS.md", "README.md", "TEAM.md"].includes(ent.name)) {
          continue;
        }
        try {
          const content = fs.readFileSync(fullPath, "utf8");
          const h1Match = content.match(/^#\s+(.+)$/m);
          const title = h1Match ? cleanArabicTitle(h1Match[1]) : "";
          const bots = extractBotsFromAttributionLines(content);
          const prNumbers = extractPrNumbers(content);
          const baseKey = path.basename(ent.name, ".md").toLowerCase();
          const parentKey = depth > 0 ? path.basename(dir).toLowerCase() : "";
          const taskKeys = Array.from(
            new Set([
              ...extractTaskKeys(rel),
              ...(baseKey.startsWith("dt-") || baseKey.startsWith("new-issues-") ? [baseKey] : []),
              ...(parentKey.startsWith("dt-") || parentKey.startsWith("new-issues-") ? [parentKey] : []),
            ]),
          );
          const priority =
            !rel.includes("/") ? 3 : ent.name === "README.md" ? 2 : ent.name === "plan.md" ? 1 : 0;
          entries.push({ rel, title, bots, prNumbers, taskKeys, priority });
        } catch {
          // ignore unreadable doc
        }
      }
    }
  }

  walk(docsDir, 0);
  entries.sort((a, b) => b.priority - a.priority);
  return entries;
}

function loadStatusHistoryIndex(statusDir) {
  const byTask = new Map();
  const byPr = new Map();
  if (!statusDir || typeof statusDir !== "string") return { byTask, byPr };

  function pushBucket(map, key, botId, title) {
    if (!key) return;
    if (!map.has(key)) map.set(key, { titles: [], bots: new Set() });
    const bucket = map.get(key);
    if (botId && CANONICAL_BOTS.includes(botId)) bucket.bots.add(botId);
    if (title && !bucket.titles.includes(title)) bucket.titles.push(title);
  }

  for (const canonicalId of CANONICAL_BOTS) {
    const filePath = path.join(statusDir, `${canonicalId}.jsonl`);
    let raw = "";
    try {
      if (!fs.existsSync(filePath)) continue;
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (!obj || typeof obj !== "object") continue;
        const rawBot = obj.bot ? String(obj.bot).trim() : canonicalId;
        const botId = BOT_ALIAS_MAP.get(rawBot) || BOT_ALIAS_MAP.get(rawBot.toLowerCase()) || canonicalId;
        const cleanedTitle = cleanArabicTitle(obj.task_title ? String(obj.task_title) : "");
        const rawTid = obj.task_id ?? obj.task;
        const tid = rawTid ? String(rawTid).trim().split(/\s+/)[0].toLowerCase().replace(/\//g, "-") : "";
        if (tid && tid !== "dt-20261121-audit") {
          pushBucket(byTask, tid, botId, cleanedTitle);
        }
        const prNums = extractPrNumbers(`${obj.task_title || ""} ${obj.step || ""}`);
        for (const pn of prNums) {
          pushBucket(byPr, pn, botId, cleanedTitle);
        }
      } catch {
        // ignore malformed jsonl line
      }
    }
  }
  return { byTask, byPr };
}

function pickBestStatusTitle(titles) {
  if (!Array.isArray(titles) || titles.length === 0) return "";
  const nonBoilerplate = titles.filter((t) => !isBoilerplateArabicTitle(t));
  const pool = nonBoilerplate.length > 0 ? nonBoilerplate : titles;
  return pool[0] || "";
}

function resolvePrEntry(pr, docsIndex, statusIndex, isMerged) {
  const num = Number(pr && pr.number);
  if (!Number.isFinite(num) || num <= 0) return null;

  const searchBlob = `${pr.headRef || ""} ${pr.head?.ref || ""} ${pr.title || ""} ${pr.body || ""}`;
  const taskKeys = extractTaskKeys(searchBlob);

  let matchedDoc = null;
  for (const key of taskKeys) {
    matchedDoc = docsIndex.find((d) => d.taskKeys.includes(key) || d.rel.toLowerCase().includes(key));
    if (matchedDoc) break;
  }
  if (!matchedDoc) {
    matchedDoc = docsIndex.find((d) => d.prNumbers.includes(num)) || null;
  }

  const prBucket = statusIndex.byPr.get(num) || null;
  let taskBucket = null;
  for (const key of taskKeys) {
    if (statusIndex.byTask.has(key)) {
      taskBucket = statusIndex.byTask.get(key);
      break;
    }
  }

  const rawTitle =
    (matchedDoc && matchedDoc.title) ||
    pickBestStatusTitle(prBucket?.titles) ||
    pickBestStatusTitle(taskBucket?.titles) ||
    "";
  const safeTitle = cleanArabicTitle(rawTitle);

  const botIds = new Set([
    ...(matchedDoc ? matchedDoc.bots : []),
    ...(prBucket ? prBucket.bots : []),
    ...(taskBucket ? taskBucket.bots : []),
  ]);
  const bots = CANONICAL_BOTS.filter((id) => botIds.has(id)).map((id) => BOT_ARABIC_NAMES[id]);

  const item = {
    number: Math.floor(num),
    title: safeTitle,
  };
  if (isMerged) {
    const mergedIso = normalizeIsoUtc(pr.merged_at || pr.mergedAt);
    if (!mergedIso) return null;
    item.merged_at = mergedIso;
  }
  if (bots.length > 0) {
    item.bots = bots;
  }
  return item;
}

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
  const token = taskId.trim().split(/\s+/)[0];
  if (!token) return null;
  const cleanId = path.basename(token);
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
  docsDir = process.env.OFFICE_DOCS_DIR || "/srv/diger-team/repo/digr/docs/diger-team",
  workDirs = DEFAULT_BOT_WORK_DIRS,
  openPrs = [],
  mergedPrs = [],
  sinceIso = MERGED_SINCE_ISO,
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

    const rawUpdatedAt = latest.updated_at ?? latest.ts;
    const updatedAt = normalizeIsoUtc(rawUpdatedAt);
    const jsonlUpdatedMs = updatedAt ? Date.parse(updatedAt) : 0;
    const workDir = workDirs
      ? botId in workDirs
        ? workDirs[botId]
        : null
      : DEFAULT_BOT_WORK_DIRS[botId];
    const folderMtimeMs = getNewestFileMtime(workDir);
    const lastActiveMs = Math.max(jsonlUpdatedMs, folderMtimeMs);
    const lastActiveIso =
      lastActiveMs > 0
        ? new Date(lastActiveMs).toISOString().replace(/\.\d{3}Z$/, "Z")
        : updatedAt || null;

    const rawTaskId = latest.task_id ?? latest.task;
    let taskId = null;
    if (rawTaskId !== undefined && rawTaskId !== null) {
      const trimmed = String(rawTaskId).trim();
      if (trimmed) {
        taskId = trimmed.split(/\s+/)[0] || null;
      }
    }
    const taskStatus = taskId ? readTaskStatus(tasksDir, taskId) : null;

    // 1. Determine percent (CTO DT-20261121-office-pct)
    // Bot line percent (clamped 0-100) when present; ONLY if the line has no percent, fall back to task status.md percent; else null.
    let percent = null;
    const hasLinePercent =
      latest.percent !== undefined &&
      latest.percent !== null &&
      latest.percent !== "" &&
      Number.isFinite(Number(latest.percent));

    if (taskId) {
      if (hasLinePercent) {
        percent = clampPercent(latest.percent);
      } else if (taskStatus && taskStatus.percent !== null && taskStatus.percent !== undefined) {
        percent = clampPercent(taskStatus.percent);
      }
    } else if (hasLinePercent) {
      const checkState = String(latest.state || "").trim().toLowerCase();
      if (checkState !== "idle" && checkState !== "done") {
        percent = clampPercent(latest.percent);
      }
    }

    // 2. Determine base state (CTO DT-20261121-office-pct)
    // The bot line's own state (working | waiting | meeting | idle; "stuck"/done -> treat as working/idle).
    // Task status.md state is used ONLY when the line has no state.
    // An idle line is idle, always. "stuck" only when the bot's OWN state is working and last activity > 45 min.
    let baseState = "idle";
    const rawLineState =
      latest.state !== undefined && latest.state !== null
        ? String(latest.state).trim().toLowerCase()
        : "";

    if (rawLineState) {
      if (rawLineState === "waiting") {
        baseState = "waiting";
      } else if (rawLineState === "meeting") {
        baseState = "meeting";
      } else if (rawLineState === "idle" || rawLineState === "done") {
        baseState = "idle";
      } else if (rawLineState === "working" || rawLineState === "stuck") {
        baseState = "working";
      } else {
        baseState = "idle";
      }
    } else if (taskStatus?.state) {
      const rawTaskState = String(taskStatus.state).trim().toLowerCase();
      if (rawTaskState === "waiting") {
        baseState = "waiting";
      } else if (rawTaskState === "meeting") {
        baseState = "meeting";
      } else if (rawTaskState === "working" || rawTaskState === "stuck") {
        baseState = "working";
      } else if (rawTaskState === "idle" || rawTaskState === "done") {
        baseState = "idle";
      } else {
        baseState = "idle";
      }
    } else if (latest.open_order) {
      baseState = "working";
    } else {
      baseState = "idle";
    }

    // 3. Resolve final state (CTO DT-20261121-office-pct)
    let state = baseState;
    if (baseState === "working") {
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

  const docsIndex = loadDocsIndex(docsDir);
  const statusIndex = loadStatusHistoryIndex(statusDir);

  const openPrsList = Array.isArray(openPrs)
    ? openPrs
        .map((pr) => resolvePrEntry(pr, docsIndex, statusIndex, false))
        .filter(Boolean)
        .sort((a, b) => b.number - a.number)
    : [];

  const mergedSeen = new Map();
  if (Array.isArray(mergedPrs)) {
    for (const pr of mergedPrs) {
      const entry = resolvePrEntry(pr, docsIndex, statusIndex, true);
      if (!entry) continue;
      if (sinceIso && entry.merged_at < sinceIso) continue;
      mergedSeen.set(entry.number, entry);
    }
  }
  const mergedList = Array.from(mergedSeen.values()).sort((a, b) => {
    const cmp = b.merged_at.localeCompare(a.merged_at);
    return cmp !== 0 ? cmp : b.number - a.number;
  });
  const mergedTotal = mergedList.length;

  const feed = {
    version: 1,
    generated_at: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    stale_after_minutes: STALE_AFTER_MINUTES,
    open_prs: prCount,
    open_prs_list: openPrsList,
    merged_total: mergedTotal,
    merged_prs: mergedList,
    bots,
  };

  while (feed.merged_prs.length > 0 && Buffer.byteLength(JSON.stringify(feed), "utf8") > MAX_FEED_BYTES) {
    feed.merged_prs.pop();
  }
  return feed;
}

export async function fetchGithubPrs({
  repo = "iammagdy/digr",
  cachePath = "/tmp/diger-office-prs-cache.json",
  nowMs = Date.now(),
  minIntervalMs = 180_000,
  timeoutMs = 12_000,
  sinceIso = MERGED_SINCE_ISO,
  fetchImpl = globalThis.fetch,
} = {}) {
  let cached = { schemaVersion: 2, fetchedAt: 0, etag: "", openPrs: [], mergedPrs: [] };
  try {
    if (cachePath && fs.existsSync(cachePath)) {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      if (
        parsed &&
        parsed.schemaVersion === 2 &&
        Array.isArray(parsed.openPrs) &&
        Array.isArray(parsed.mergedPrs)
      ) {
        cached = parsed;
      }
    }
  } catch {
    cached = { schemaVersion: 2, fetchedAt: 0, etag: "", openPrs: [], mergedPrs: [] };
  }

  if (nowMs - (cached.fetchedAt || 0) < minIntervalMs && cached.fetchedAt > 0) {
    return { openPrs: cached.openPrs, mergedPrs: cached.mergedPrs };
  }

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "diger-office-feed-updater",
  };
  if (cached.etag) headers["If-None-Match"] = cached.etag;

  try {
    const fetchOpts = { headers };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      fetchOpts.signal = AbortSignal.timeout(timeoutMs);
    }
    const res = await fetchImpl(
      `https://api.github.com/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
      fetchOpts,
    );
    if (res.status === 304) {
      cached.fetchedAt = nowMs;
      try {
        if (cachePath) fs.writeFileSync(cachePath, JSON.stringify(cached), "utf8");
      } catch {
        // ignore cache write failure
      }
      return { openPrs: cached.openPrs, mergedPrs: cached.mergedPrs };
    }
    if (!res.ok) {
      return { openPrs: cached.openPrs, mergedPrs: cached.mergedPrs };
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      return { openPrs: cached.openPrs, mergedPrs: cached.mergedPrs };
    }

    const openPrs = data
      .filter((pr) => pr && pr.state === "open")
      .map((pr) => ({
        number: Number(pr.number),
        title: String(pr.title || ""),
        headRef: String(pr.head?.ref || ""),
        created_at: normalizeIsoUtc(pr.created_at) || null,
      }))
      .filter((pr) => Number.isFinite(pr.number) && pr.number > 0)
      .sort((a, b) => b.number - a.number);

    const mergedByNumber = new Map();
    for (const prev of cached.mergedPrs) {
      if (prev && Number.isFinite(Number(prev.number)) && prev.merged_at && prev.merged_at >= sinceIso) {
        mergedByNumber.set(Number(prev.number), prev);
      }
    }
    for (const pr of data) {
      if (!pr || !pr.merged_at) continue;
      if (pr.base?.ref && pr.base.ref !== "main") continue;
      const mergedIso = normalizeIsoUtc(pr.merged_at);
      if (!mergedIso || mergedIso < sinceIso) continue;
      const num = Number(pr.number);
      if (!Number.isFinite(num) || num <= 0) continue;
      mergedByNumber.set(num, {
        number: num,
        title: String(pr.title || ""),
        headRef: String(pr.head?.ref || ""),
        merged_at: mergedIso,
      });
    }
    const mergedPrs = Array.from(mergedByNumber.values()).sort((a, b) => {
      const cmp = b.merged_at.localeCompare(a.merged_at);
      return cmp !== 0 ? cmp : b.number - a.number;
    });

    const nextCache = {
      schemaVersion: 2,
      fetchedAt: nowMs,
      etag: res.headers?.get?.("etag") || "",
      openPrs,
      mergedPrs,
    };
    try {
      if (cachePath) fs.writeFileSync(cachePath, JSON.stringify(nextCache), "utf8");
    } catch {
      // ignore cache write failure
    }
    return { openPrs, mergedPrs };
  } catch {
    return { openPrs: cached.openPrs, mergedPrs: cached.mergedPrs };
  }
}

export async function fetchOpenPrs(opts = {}) {
  const res = await fetchGithubPrs(opts);
  return res.openPrs.length;
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
  const docsDir = process.env.OFFICE_DOCS_DIR || "/srv/diger-team/repo/digr/docs/diger-team";
  const repo = process.env.OFFICE_GITHUB_REPO || "iammagdy/digr";
  const uploadUrl = process.env.OFFICE_UPLOAD_URL || "";
  const uploadKey = process.env.OFFICE_UPLOAD_KEY || "";
  const cachePath = process.env.OFFICE_PR_CACHE_PATH || "/tmp/diger-office-prs-cache.json";

  const { openPrs, mergedPrs } = await fetchGithubPrs({ repo, cachePath });
  const feed = buildOfficeFeed({ statusDir, tasksDir, docsDir, openPrs, mergedPrs });

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
