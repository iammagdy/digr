import { createHash } from "node:crypto";
import { toArabicDigits } from "../arabicDigits";

/**
 * P0 (15 Nov 2026, msn_8824508f840f703dee69): «WITHOUT REPEATING WHAT YOU ALREADY GAVE ME» IS ENFORCED, NOT PROMISED.
 *
 * The customer asked «هل ممكن تتوسع اكتر في استخراج التغريدات من دون تكرار»: more of the SAME research, and nothing already delivered again. The chat model reads that intent (the brief's `exclude_delivered`, written by the model
 * from the whole conversation, never from a keyword list) and the chat SERVER records, on the new mission's card (`messages.plan.priorDelivery`, server-written: customers cannot write an assistant message's plan), the earlier missions
 * of this conversation. The worker then:
 *   1. at planning, verifies those missions are this customer's and delivered something, reads THEIR item stores, and builds the identities of every item they delivered (`deliveryKeysOf`: the item id and the item's canonical link);
 *      the snapshot is written to the mission's private folder and pinned by its digest on the plan the customer approves, with one sentence on the card saying how many items are excluded;
 *   2. never chooses a previously delivered row as a planning sample, and never counts one as available;
 *   3. at execution loads exactly the approved snapshot (a missing or altered copy stops the mission before any call: fail closed) and refuses every row whose identity is in it: never delivered, never counted, never charged
 *      (the item store's reason `already_delivered`).
 * Nothing here changes a price or a balance: an excluded row is simply not a delivered row.
 */
export const PRIOR_DELIVERY_PATH = "inputs/prior-delivered.json";
export const PRIOR_DELIVERY_REASON = "already_delivered" as const;
/** The earlier missions one continuation may exclude (a conversation's own history; a safety bound, never reached in normal use). */
export const PRIOR_DELIVERY_MAX_MISSIONS = 20;
/** The identities kept (two per item: id and link). */
export const PRIOR_DELIVERY_MAX_KEYS = 100_000;

/**
 * `running`: earlier missions still executing (what they collected so far is excluded; what they collect later is not known yet). `unreadable`: earlier missions that delivered but whose items could not be read (an older storage).
 * Both are said on the card, so the customer never reads «nothing to exclude» when that is not known.
 */
export interface PriorDeliverySnapshot { v: 1; missions: string[]; items: number; keys: string[]; digest: string; running?: number; unreadable?: number }
/** What the APPROVED plan records: the digest of the exact snapshot, the missions and the items it excludes. Never the identities themselves (the plan text reaches models). */
export interface PlanPriorDelivery { digest: string; missions: number; items: number; running?: number; unreadable?: number }

const PLATFORM_HOSTS: Array<[RegExp, string]> = [[/^(?:.*\.)?(?:x|twitter)\.com$/, "x"], [/^(?:.*\.)?tiktok\.com$/, "tiktok"], [/^(?:.*\.)?instagram\.com$/, "instagram"], [/^(?:.*\.)?facebook\.com$|^fb\.com$/, "facebook"], [/^(?:.*\.)?(?:youtube\.com|youtu\.be)$/, "youtube"]];

/** The canonical identity of an item's link, or null. A post has one identity however its link is written (x.com or twitter.com, with or without www, a query string, a trailing slash, another spelling of the author's handle). */
export function canonicalLinkOf(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  let u: URL;
  try { u = new URL(value.trim()); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(?:www|m|mobile|web)\./, "");
  const platform = PLATFORM_HOSTS.find(([re]) => re.test(host))?.[1] ?? null;
  const path = u.pathname.replace(/\/+$/, "");
  if (platform === "x") { const m = /\/status(?:es)?\/(\d+)/.exec(path); if (m) return `x:status:${m[1]}`; }
  if (platform === "tiktok") { const m = /\/(?:video|photo)\/(\d+)/.exec(path); if (m) return `tiktok:video:${m[1]}`; }
  if (platform === "youtube") {
    const v = u.searchParams.get("v") ?? (host === "youtu.be" ? path.slice(1) : (/\/(?:shorts|live|embed)\/([\w-]+)/.exec(path)?.[1] ?? null));
    if (v) return `youtube:video:${v}`;
  }
  if (platform === "instagram") { const m = /\/(?:p|reel|reels|tv)\/([\w-]+)/.exec(path); if (m) return `instagram:media:${m[1]}`; }
  return `url:${host}${path}`;
}

/** The identities of one item: its id and its canonical link (either one matching is the same item). */
export function deliveryKeysOf(row: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const id = String(row.id ?? "").trim();
  if (id) keys.push(`id:${id}`);
  for (const k of ["link", "url", "permalink"]) { const c = canonicalLinkOf(row[k]); if (c) { keys.push(c); break; } }
  return keys;
}

const digestOf = (missions: ReadonlyArray<string>, keys: ReadonlyArray<string>): string => createHash("sha256").update(JSON.stringify({ missions, keys })).digest("hex");

/** The snapshot of what earlier missions delivered (their accepted items), deterministic: the same missions and items give the same digest. */
export function priorDeliverySnapshotOf(missions: ReadonlyArray<{ id: string; rows: ReadonlyArray<Record<string, unknown>> }>, caveats: { running?: number; unreadable?: number } = {}): PriorDeliverySnapshot {
  const ids = [...new Set(missions.map((m) => m.id))].sort();
  const keys = new Set<string>();
  let items = 0;
  for (const m of missions) for (const r of m.rows) {
    const k = deliveryKeysOf(r);
    if (k.length === 0) continue;
    items += 1;
    for (const x of k) if (keys.size < PRIOR_DELIVERY_MAX_KEYS) keys.add(x);
  }
  const sorted = [...keys].sort();
  return { v: 1, missions: ids, items, keys: sorted, digest: digestOf(ids, sorted), ...(caveats.running ? { running: caveats.running } : {}), ...(caveats.unreadable ? { unreadable: caveats.unreadable } : {}) };
}

/** The stored snapshot, read back; null when it is malformed or its digest does not match its content. */
export function parsePriorDeliverySnapshot(raw: unknown): PriorDeliverySnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || !Array.isArray(o.missions) || !Array.isArray(o.keys) || typeof o.digest !== "string" || typeof o.items !== "number") return null;
  if (!o.missions.every((m) => typeof m === "string") || !o.keys.every((k) => typeof k === "string")) return null;
  const missions = o.missions as string[];
  const keys = o.keys as string[];
  if (digestOf(missions, keys) !== o.digest) return null;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return { v: 1, missions, items: o.items, keys, digest: o.digest, ...(n(o.running) ? { running: n(o.running) } : {}), ...(n(o.unreadable) ? { unreadable: n(o.unreadable) } : {}) };
}

export type PriorDeliveryMatcher = (row: Record<string, unknown>) => boolean;
export function priorDeliveryMatcherOf(snapshot: Pick<PriorDeliverySnapshot, "keys">): PriorDeliveryMatcher {
  const set = new Set(snapshot.keys);
  return (row) => deliveryKeysOf(row).some((k) => set.has(k));
}

export const planPriorDeliveryOf = (s: PriorDeliverySnapshot): PlanPriorDelivery => ({ digest: s.digest, missions: s.missions.length, items: s.items, ...(s.running ? { running: s.running } : {}), ...(s.unreadable ? { unreadable: s.unreadable } : {}) });

const missionsAr = (n: number): string => `${toArabicDigits(n)} ${n === 1 ? "مهمة سابقة" : "مهام سابقة"}`;
/** The card's sentence (said once, with the numbers the snapshot holds; what is not known is said, never «nothing to exclude»). */
export function priorDeliveryLineAr(p: Pick<PlanPriorDelivery, "missions" | "items" | "running" | "unreadable">): string {
  const caveats = [
    ...(p.running ? [`${missionsAr(p.running)} ما زالت قيد التنفيذ: استبعدنا ما جُمع منها حتى الآن فقط، وما تجمعه بعد ذلك قد يتكرر`] : []),
    ...(p.unreadable ? [`تعذّر علينا قراءة ما سُلّم في ${missionsAr(p.unreadable)}، فلا نضمن عدم تكرار ما سُلّم فيها`] : []),
  ];
  const tail = caveats.length > 0 ? ` ${caveats.join("، و")}.` : "";
  if (p.items <= 0) return caveats.length > 0 ? `طلبت ألا يتكرر ما سلّمناه لك من قبل:${tail}` : "طلبت ألا يتكرر ما سلّمناه لك من قبل: لم نجد في هذه المحادثة عناصر سُلّمت لك سابقًا، فلا شيء يُستبعد.";
  return `طلبت ألا يتكرر ما سلّمناه لك من قبل: نستبعد ${toArabicDigits(p.items)} عنصرًا سُلّم لك في ${missionsAr(p.missions)} في هذه المحادثة، فلا يُسلَّم مرة أخرى ولا يُحتسب، وقد يكون الجديد أقل من العدد المطلوب.${tail}`;
}
/** The planning sample's sentence when some of what was read had been delivered before. */
export const priorDeliverySampleAr = (n: number): string => `من العينة التي قرأناها ${toArabicDigits(n)} سبق أن سلّمناه لك، فلم نختره ولم نحسبه.`;
/** The file's methodology / the closing sentence: why such an item is not in the file. */
export const PRIOR_DELIVERY_REASON_TEXT_AR = "سُلّم لك في مهمة سابقة";
