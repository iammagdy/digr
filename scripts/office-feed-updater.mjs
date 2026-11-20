#!/usr/bin/env node
/**
 * Non-AI server updater for diger.tech/office live team status feed (D-0151).
 * Reads sanitized JSONL status lines written by bots under OFFICE_STATUS_DIR,
 * merges open GitHub PR numbers/titles from the public repo API (cached via ETag),
 * marks open-order bots silent > 45 min as "stuck", and uploads status.json.
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

export const STALE_AFTER_MINUTES = 45;
export const STALE_AFTER_MS = STALE_AFTER_MINUTES * 60 * 1000;

const SECRET_REGEXES = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
  /\btreg_[A-Za-z0-9_-]{10,}\b/g,
];

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PRIVATE_PATH_REGEX = /(?:^|[\s"'`(])(\/(?:srv|var|home|etc|root|tmp|Users)\/[^\s"'`),;]+)/g;

export function sanitizeText(value, maxLen = 120) {
  if (typeof value !== "string") return "";
  let out = value;
  for (const rx of SECRET_REGEXES) {
    out = out.replace(rx, "[redacted]");
  }
  out = out.replace(EMAIL_REGEX, "[redacted-email]");
  out = out.replace(PRIVATE_PATH_REGEX, (m, p) => m.replace(p, "[path]"));
  out = out.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (out.length > maxLen) {
    out = out.slice(0, maxLen - 1).trimEnd() + "…";
  }
  return out;
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

function defaultIdleBot(botId) {
  return {
    bot: botId,
    state: "idle",
    task_id: null,
    task_title: "",
    step: "",
    percent: 0,
    next: "",
    updated_at: null,
    open_order: false,
    recent: [],
  };
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
      // Ignore malformed line without crashing feed build
    }
  }
  if (entries.length === 0) return { latest: null, recent: [] };

  const latest = entries[entries.length - 1];
  const recent = [];
  const seen = new Set();
  for (let i = entries.length - 1; i >= 0 && recent.length < 3; i--) {
    const e = entries[i];
    const pct = clampPercent(e.percent);
    const st = String(e.state || "").toLowerCase();
    const isDone = pct === 100 || (st === "idle" && e.open_order === false && (e.task_id || e.task_title));
    if (!isDone) continue;
    const tid = sanitizeText(String(e.task_id || ""), 40);
    const ttl = sanitizeText(String(e.task_title || e.step || ""), 80);
    const label = tid && ttl ? `${tid} — ${ttl}` : tid || ttl;
    if (label && !seen.has(label)) {
      seen.add(label);
      recent.push(label);
    }
  }
  return { latest, recent };
}

/**
 * @param {{ statusDir: string, openPrs?: Array<{ number: number, title: string }>, nowMs?: number }} opts
 * @returns {{ version: number, generated_at: string, stale_after_minutes: number, open_prs: Array<{ number: number, title: string }>, bots: Record<string, { bot: string, state: string, task_id: string | null, task_title: string, step: string, percent: number, next: string, updated_at: string | null, open_order: boolean, recent: string[] }> }}
 */
export function buildOfficeFeed({ statusDir, openPrs = [], nowMs = Date.now() }) {
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
    const { latest, recent } = parseBotJsonl(raw, botId);
    if (!latest) {
      bots[botId] = defaultIdleBot(botId);
      continue;
    }

    const updatedAt = normalizeIsoUtc(latest.updated_at);
    const rawState = String(latest.state || "idle").toLowerCase();
    const openOrder = Boolean(latest.open_order ?? (rawState === "working" || rawState === "stuck"));

    let state = "idle";
    if (rawState === "stuck") {
      state = "stuck";
    } else if (openOrder) {
      const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN;
      const isStale = !Number.isFinite(updatedMs) || nowMs - updatedMs > STALE_AFTER_MS;
      state = isStale ? "stuck" : "working";
    } else if (rawState === "working") {
      const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN;
      const isStale = !Number.isFinite(updatedMs) || nowMs - updatedMs > STALE_AFTER_MS;
      state = isStale ? "stuck" : "working";
    }

    const taskId = sanitizeText(String(latest.task_id || ""), 40) || null;
    bots[botId] = {
      bot: botId,
      state,
      task_id: taskId,
      task_title: sanitizeText(String(latest.task_title || ""), 80),
      step: sanitizeText(String(latest.step || ""), 120),
      percent: clampPercent(latest.percent),
      next: sanitizeText(String(latest.next || ""), 120),
      updated_at: updatedAt,
      open_order: openOrder,
      recent,
    };
  }

  const sanitizedPrs = Array.isArray(openPrs)
    ? openPrs
        .filter((p) => p && Number.isInteger(Number(p.number)))
        .slice(0, 10)
        .map((p) => ({
          number: Number(p.number),
          title: sanitizeText(String(p.title || ""), 100),
        }))
    : [];

  return {
    version: 1,
    generated_at: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    stale_after_minutes: STALE_AFTER_MINUTES,
    open_prs: sanitizedPrs,
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
  let cached = { fetchedAt: 0, etag: "", openPrs: [] };
  try {
    if (cachePath && fs.existsSync(cachePath)) {
      cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) || cached;
    }
  } catch {
    cached = { fetchedAt: 0, etag: "", openPrs: [] };
  }

  if (nowMs - (cached.fetchedAt || 0) < minIntervalMs && Array.isArray(cached.openPrs)) {
    return cached.openPrs;
  }

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "diger-office-feed-updater",
  };
  if (cached.etag) headers["If-None-Match"] = cached.etag;

  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=10`, { headers });
    if (res.status === 304) {
      cached.fetchedAt = nowMs;
      if (cachePath) fs.writeFileSync(cachePath, JSON.stringify(cached), "utf8");
      return cached.openPrs || [];
    }
    if (!res.ok) return cached.openPrs || [];
    const data = await res.json();
    const prs = Array.isArray(data)
      ? data.map((p) => ({ number: p.number, title: sanitizeText(String(p.title || ""), 100) }))
      : [];
    const nextCache = {
      fetchedAt: nowMs,
      etag: res.headers.get("etag") || "",
      openPrs: prs,
    };
    if (cachePath) fs.writeFileSync(cachePath, JSON.stringify(nextCache), "utf8");
    return prs;
  } catch {
    return cached.openPrs || [];
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

async function main() {
  const statusDir = process.env.OFFICE_STATUS_DIR || "/srv/diger-team/shared/office-status";
  const repo = process.env.OFFICE_GITHUB_REPO || "iammagdy/digr";
  const uploadUrl = process.env.OFFICE_UPLOAD_URL || "";
  const uploadKey = process.env.OFFICE_UPLOAD_KEY || "";
  const cachePath = process.env.OFFICE_PR_CACHE_PATH || "/tmp/diger-office-prs-cache.json";

  const openPrs = await fetchOpenPrs({ repo, cachePath });
  const feed = buildOfficeFeed({ statusDir, openPrs });
  await uploadFeed({ feedJson: feed, uploadUrl, uploadKey });
  console.log(`office-feed-updated bots=${Object.keys(feed.bots).length} prs=${feed.open_prs.length} at=${feed.generated_at}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("office-feed-error:", err instanceof Error ? err.message : "unknown");
    process.exit(1);
  });
}
