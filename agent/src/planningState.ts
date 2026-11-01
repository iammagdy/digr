import { createHash } from "node:crypto";
import type { RunState } from "./tools";
import type { AgentStore } from "./types";

/**
 * THE PLANNING NOTE (S1 item 1.11, docs/REDESIGN.md section 4 «checkpointed planning»). After each tool turn of a planning run, what the run has learned is saved to `planning_state.json` in the mission's own folder: the sources tried, the samples taken (rows and a key of the
 * inputs), the FULL inputs of every call (the plan's recipe is derived from them), the skips with their reasons, the descriptions read, the last ranking and the last progress note. A run that is stopped (a restart, the memory guard) is resumed from it: the state is restored and the prompt says
 * what was already done, so the paid samples are not taken again. Never critical: a missing or broken note is read as «nothing», and a failed write only costs the resume. No secret goes in (keys named like a secret are dropped), and the size is bounded.
 */
export const PLANNING_STATE_FILE = "planning_state.json";
export const PLANNING_STATE_MAX_BYTES = 50_000;
const MAX_CALLS = 40;
const MAX_VALUE_CHARS = 300;
const SECRET_KEY = /(api[_-]?key|apikey|token|secret|password|passwd|authorization|bearer|credential|cookie)/i;
const SECRET_VALUE = /^(sk-|bearer\s|ghp_|xox[bap]-)/i;

export interface PlanningSnapshot {
  version: 1;
  tried: string[];
  samples: Record<string, Array<{ rows: number; key: string }>>;
  callParams: Record<string, Record<string, unknown>>;
  skips: Record<string, string>;
  described: string[];
  ranking: string[] | null;
  /** The last progress note the model wrote (Arabic, the customer already sees it). */
  summary_ar: string | null;
  /** The run had already asked its question / proposed its plan when it stopped (kept for the admin; never restored). */
  hadQuestion: boolean;
  hadPlan: boolean;
}

/** The inputs of a call without anything that looks like a secret, long values cut. */
function scrub(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (SECRET_KEY.test(k)) continue;
    if (typeof v === "string") { if (SECRET_VALUE.test(v.trim())) continue; out[k] = v.length > MAX_VALUE_CHARS ? v.slice(0, MAX_VALUE_CHARS) : v; }
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else { try { const t = JSON.stringify(v); if (t.length <= MAX_VALUE_CHARS && !SECRET_VALUE.test(t)) out[k] = v; } catch { /* a value that cannot be written is left out */ } }
  }
  return out;
}

export function snapshotOf(state: RunState, summaryAr: string | null): PlanningSnapshot {
  const calls = [...state.callParams.entries()].slice(-MAX_CALLS);
  const snap: PlanningSnapshot = {
    version: 1,
    tried: [...state.tried],
    samples: Object.fromEntries([...state.samples.entries()].map(([k, v]) => [k, v.slice(-MAX_CALLS).map((s) => ({ rows: Number(s.rows) || 0, key: createHash("sha1").update(String(s.key)).digest("hex").slice(0, 12) }))])),
    callParams: Object.fromEntries(calls.map(([id, p]) => [id, scrub(p)])),
    skips: Object.fromEntries([...state.skips.entries()].map(([k, v]) => [k, String(v).slice(0, 80)])),
    described: [...state.described],
    ranking: state.ranking ? [...state.ranking] : null,
    summary_ar: summaryAr ? summaryAr.slice(0, 200) : null,
    hadQuestion: state.question !== null,
    hadPlan: state.proposedPlan !== null,
  };
  // bounded: the oldest calls go first when the note is too large
  while (JSON.stringify(snap).length > PLANNING_STATE_MAX_BYTES && Object.keys(snap.callParams).length > 1) delete snap.callParams[Object.keys(snap.callParams)[0]];
  return snap;
}

/** Restores what the earlier run learned into the new run's state. (The plan and the question are not restored: a run that had one ended with it.) */
export function applySnapshot(state: RunState, snap: PlanningSnapshot): void {
  for (const e of snap.tried) state.tried.add(e);
  for (const [e, list] of Object.entries(snap.samples)) state.samples.set(e, list.map((s) => ({ rows: s.rows, key: s.key })));
  for (const [id, p] of Object.entries(snap.callParams)) state.callParams.set(id, { ...p });
  for (const [k, v] of Object.entries(snap.skips)) state.skips.set(k, v);
  for (const d of snap.described) state.described.add(d);
  if (snap.ranking && state.ranking === null) state.ranking = [...snap.ranking];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function readPlanningState(store: AgentStore, missionId: string): Promise<PlanningSnapshot | null> {
  try {
    const text = await store.getFile(missionId, PLANNING_STATE_FILE);
    if (!text) return null;
    const o: unknown = JSON.parse(text);
    if (!isObject(o) || o.version !== 1) return null;
    const samples: PlanningSnapshot["samples"] = {};
    if (isObject(o.samples)) for (const [k, v] of Object.entries(o.samples)) if (Array.isArray(v)) samples[k] = v.filter(isObject).map((s) => ({ rows: Number(s.rows) || 0, key: String(s.key ?? "") }));
    const callParams: PlanningSnapshot["callParams"] = {};
    if (isObject(o.callParams)) for (const [k, v] of Object.entries(o.callParams)) if (isObject(v) && /^call_\d{4,6}$/.test(k)) callParams[k] = scrub(v);
    const skips: Record<string, string> = {};
    if (isObject(o.skips)) for (const [k, v] of Object.entries(o.skips)) skips[k] = String(v);
    return { version: 1, tried: strings(o.tried), samples, callParams, skips, described: strings(o.described), ranking: Array.isArray(o.ranking) ? strings(o.ranking) : null, summary_ar: typeof o.summary_ar === "string" ? o.summary_ar : null, hadQuestion: o.hadQuestion === true, hadPlan: o.hadPlan === true };
  } catch { return null; }
}

/** Saves the note. Never throws. */
export async function writePlanningState(store: AgentStore, missionId: string, snap: PlanningSnapshot, log?: (line: string) => void): Promise<void> {
  try { await store.putFile(missionId, PLANNING_STATE_FILE, JSON.stringify(snap), "application/json"); } catch (e) { log?.(`planning_state_not_saved ${missionId} ${String((e as Error)?.message ?? e).slice(0, 80)}`); }
}

/** What the resumed run is told (the other prompts are English instructions to the model). Empty when the earlier run did nothing worth carrying over. */
export function resumeNoteOf(snap: PlanningSnapshot): string {
  const samples = Object.entries(snap.samples).filter(([, l]) => l.length > 0).map(([e, l]) => `${e} (${l.length} sample call${l.length === 1 ? "" : "s"}, ${l.map((s) => s.rows).join("+")} rows)`);
  if (snap.tried.length === 0 && samples.length === 0 && snap.described.length === 0) return "";
  return [
    "THIS IS A RESUMED RUN: an earlier run of this same planning was stopped (a restart or the memory guard) after it already did the work below. Do NOT repeat it; the pages are saved and the paid samples were already taken.",
    snap.tried.length ? `Sources already tried: ${snap.tried.join(", ")}.` : "",
    samples.length ? `Samples already taken: ${samples.join("; ")}.` : "",
    snap.described.length ? `Descriptions already read: ${snap.described.join(", ")}.` : "",
    Object.keys(snap.skips).length ? `Sources skipped on purpose: ${Object.entries(snap.skips).map(([k, v]) => `${k} (${v})`).join(", ")}.` : "",
    snap.summary_ar ? `Your last progress note was: «${snap.summary_ar}».` : "",
    "Continue from here: use the saved pages with run_code, sample only sources not listed above, then propose the plan.",
  ].filter(Boolean).join("\n");
}
