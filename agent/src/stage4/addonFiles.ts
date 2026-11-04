import { versionPathOf, type FileVersion } from "../../../src/lib/agentMission/stage4/versions";
import type { AddonKind } from "../../../src/lib/agentMission/addonSettlement";
import type { AgentStore } from "../types";

/**
 * MONEY PR 7a, PHASE 2B-1: WHERE AN ADD-ON KEEPS ITS WORK (docs/MONEY-PR-7A.md section 3.0). Everything is a create-only object in the DELIVERED mission's folder (`of`): nothing is ever overwritten, so a retry reads exactly what the
 * first run wrote and no read is stale.
 *   addons/<add-on id>/rows/u_<hash>.json   one object per unit the re-read has finished (a resumed run skips them)
 *   addons/<add-on id>/v<NNNN>.json         the new version, PENDING: stored BEFORE the charge, not yet visible
 *   addons/<add-on id>/review.json          the review's report, PENDING
 *   addons/<add-on id>/freeze.json          the SETTLEMENT SNAPSHOT, written ONCE, first writer wins: the new version and the real cost that paid for it, in ONE object (so no later call of another worker can ever be counted for it)
 *   addons/<add-on id>/outcome.json         what the run found (filled, requested, the real cost): the inputs of the charge, fixed for every retry
 *   versions/v<NNNN>.json                   the published version (the S2 list reads this folder)
 *   reviews/r<NNNN>.json                    the published report of the version NNNN
 */
const pad = (n: number): string => String(Math.max(1, Math.floor(n))).padStart(4, "0");
export const pendingVersionPath = (addonId: string, version: number): string => `addons/${addonId}/v${pad(version)}.json`;
export const pendingReviewPath = (addonId: string): string => `addons/${addonId}/review.json`;
export const freezePath = (addonId: string): string => `addons/${addonId}/freeze.json`;
export const outcomePath = (addonId: string): string => `addons/${addonId}/outcome.json`;
export const rowsDir = (addonId: string): string => `addons/${addonId}/rows`;
export const reviewPathOf = (version: number): string => `reviews/r${pad(version)}.json`;
export { versionPathOf };
const JSON_TYPE = "application/json";

export type RereadStop = "daily_cap" | "budget" | "recording" | "deadline" | null;
/** What the run found, written ONCE before the settlement: the charge is computed from it by code and a retry reads the very same numbers. */
export interface AddonOutcome {
  v: 1;
  kind: AddonKind;
  addonId: string;
  of: string;
  baseVersion: number;
  newVersion: number | null;
  /** Units that received a REAL value (a review: 1 when its report was stored, else 0). */
  filled: number;
  requested: number;
  /** The real provider cost of the add-on's own execution calls, USD. */
  realCostUsd: number;
  stop: RereadStop;
  /** Why nothing was filled (the customer's sentence is chosen from it): null when something was. */
  reason: "nothing" | "no_base" | "mismatch" | "review_exists" | "version_exists" | null;
  /** The pending object that holds the work (null when nothing was filled). */
  pending: string | null;
  /** Where it will be published. */
  publishAt: string | null;
  createdAt: string;
}

export async function readJson<T>(store: AgentStore, missionId: string, rel: string): Promise<T | null> {
  const text = await store.getFile(missionId, rel);
  if (text === null) return null;
  return JSON.parse(text) as T;
}

/**
 * The object as data, or null when it is NOT THERE or is not well-formed JSON. A STORAGE FAILURE is never turned into null (the store throws it): a failed read is not proof that an object is absent, and the runner decides
 * «no outcome yet», «no such version» and «no report made» from these answers.
 */
export async function readJsonOrNull<T>(store: AgentStore, missionId: string, rel: string): Promise<T | null> {
  const text = await store.getFile(missionId, rel);
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

/** The frozen work: the version the run built and the real cost of the calls that paid for it, taken at the same moment. Whoever writes it first decides it for every worker and every retry. */
export interface AddonFreeze {
  v: 1;
  addonId: string;
  of: string;
  version: FileVersion;
  /** The real provider cost of the add-on's own execution calls AT THE MOMENT OF THE FREEZE, USD. */
  realCostUsd: number;
  stop: RereadStop;
  createdAt: string;
}
export async function readFreeze(store: AgentStore, of: string, addonId: string): Promise<AddonFreeze | null> {
  const f = await readJsonOrNull<AddonFreeze>(store, of, freezePath(addonId));
  return f && f.v === 1 && f.addonId === addonId && f.version && typeof f.realCostUsd === "number" ? f : null;
}
/** Create-only: the FIRST writer wins; a later writer gets the stored one back and its own numbers are dropped. */
export async function writeFreeze(store: AgentStore, freeze: AddonFreeze): Promise<AddonFreeze> {
  const put = await store.putNewStrict(freeze.of, freezePath(freeze.addonId), JSON.stringify(freeze), JSON_TYPE);
  if (put.created) return freeze;
  const stored = await readFreeze(store, freeze.of, freeze.addonId);
  if (!stored) throw new Error("the freeze exists but cannot be read");
  return stored;
}

/** The outcome, if the run already wrote it. */
export async function readOutcome(store: AgentStore, of: string, addonId: string): Promise<AddonOutcome | null> {
  const o = await readJsonOrNull<AddonOutcome>(store, of, outcomePath(addonId));
  return o && o.v === 1 && o.addonId === addonId ? o : null;
}

/** Writes the outcome create-only. The FIRST writer wins: if one already exists (a run that was cut after writing it), that one is returned and the new numbers are dropped. */
export async function writeOutcome(store: AgentStore, outcome: AddonOutcome): Promise<AddonOutcome> {
  const put = await store.putNewStrict(outcome.of, outcomePath(outcome.addonId), JSON.stringify(outcome), JSON_TYPE);
  if (put.created) return outcome;
  const stored = await readOutcome(store, outcome.of, outcome.addonId);
  if (!stored) throw new Error("the outcome exists but cannot be read");
  return stored;
}

/** A version of the delivered mission, read from its own create-only object; null when it is absent or not a well-formed version. */
export async function readVersion(store: AgentStore, of: string, version: number): Promise<FileVersion | null> {
  const v = await readJsonOrNull<FileVersion>(store, of, versionPathOf(version));
  return v && v.v === 1 && v.version === version && Array.isArray(v.sheets) && typeof v.digest === "string" ? v : null;
}

export { JSON_TYPE };
