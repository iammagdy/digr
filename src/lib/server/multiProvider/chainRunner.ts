import { capabilityById, isSellable, PROVIDER_FACTS } from "../../multiProvider/catalog";
import {
  budgetStopLineAr, chainFailureReasonAr, chainFinishedLineAr, chainStopProgressLineAr, type ChainRunnerStop, discoveryEmptyLineAr, discoveryLineAr, enrichLineAr, skippedSitesLineAr, stageFallbackLineAr,
} from "../../multiProvider/copy";
import {
  buildContactRow, checkPublicBusinessUrl, checkRobots, companyDomain, extractEmails, extractPhones, extractProfileLink, linksFromMarkdown,
  parseDecisionMakers, pickContactPages, rowPassesGate, type DecisionMaker, type EnrichmentFacts, type FoundEmail, type FoundPhone, type RobotsFetch, type RobotsRules,
} from "../../multiProvider/policy";
import { cleanCompanyName, cleanMarkdownText, isListOrArticleTitle, markForeignPhones, nonCompanyReasonAr } from "../../companyRowHygiene";
import { isoCountryCodeFromName } from "../../planParameters";
import { reserveForUnits } from "../../recordPricing";
import { HARD_LIMITS, YIELD, estimateRoute, routeByCode, verifiedShareFor } from "../../multiProvider/routes";
import type { CapabilityDef, DataProviderId, RequiredField, RouteDef, RouteRequest } from "../../multiProvider/types";
import type { ProviderAdapterCallInput, ProviderAdapterCallOutput, ProviderAdapterFn } from "../tregAdapter";
import { ADAPTERS, runTregDirectoryPage, runTregDirectoryPageDirect, runTregEmailLookup, buildTregIdempotencyKey } from "./adapters";
import type { AdapterContext, CallRecord, CallRecorder, CallStatus, FetchFn, OperationResult, SearchHit } from "./adapterTypes";
import { ChunkTraceCollector, type ChunkTrace } from "../../multiProvider/trace";
import { HOST_RE, ORIGIN_CHARSET_RE, TREG_DIRECTORY, TREG_EMAIL_LOOKUP, escapedBytes, readTombaMailbox, sameInstant, stripControl, utf8Bytes } from "../../multiProvider/tregContacts";
import type { TregCallOptions, TregCallResult } from "../../../functions/shared/tregClient";
import { KEYWORDS_ONLY_CURSOR_PREFIX, normalizeIcypeasCompanyParams } from "../tregAdapter";


/**
 * Runs one chunk of a bounded chain: DISCOVER companies (a provider, with fallbacks) -> ENRICH each company from its public contact
 * pages (a provider, with fallbacks) -> VERIFY in code. It plugs into the worker through the existing provider-adapter seam, so the
 * reserve, the row gate, the files, the settlement and the release are the production code, unchanged. Its own rules:
 *  - every billed call goes through the call recorder (reserve against the provider's daily cap, commit the real cost);
 *  - each stage has a hard maximum number of billed calls, counted across chunks in the cursor;
 *  - the provider spend of the whole job never passes the route budget (the estimate plus the 15% buffer);
 *  - a stage that fails or returns nothing falls to the next ALLOWED provider for that stage; a site that REFUSES a read is never
 *    retried on another provider (that would be a way around its block);
 *  - a row is delivered only when every required field is verified (the policy module), otherwise it is neither delivered nor charged;
 *  - nothing delivered means `ok` with no rows and no next cursor: the worker settles zero and releases the whole reserve.
 */

export type ChainChunkInput = ProviderAdapterCallInput & { claimLeaseUntil?: string; startIndex?: number };

export interface ChainDeps {
  /** Usable providers at run time: a key is present (TREG holds its own key, so any non-empty marker means «present»). */
  providerKeys: Partial<Record<DataProviderId, string>>;
  fetchFn: FetchFn;
  recorder: CallRecorder;
  tregFn: ProviderAdapterFn;
  robotsFetch: RobotsFetch;
  /** What the providers have cost THIS job so far (read from provider_costs), before this chunk. */
  spentUsdSoFar: () => Promise<number>;
  /** One plain-Arabic line of the job's activity log (the existing job_events mechanism). */
  emit: (lineAr: string, units: number) => Promise<void>;
  /** Receives this chunk's routing trace (admin only; see trace.ts). Best effort: a failure here never touches the job. */
  trace?: (chunk: ChunkTrace) => Promise<void>;
  /** The worker's step number of this chunk (the trace is merged by step, so a retried chunk replaces itself). */
  step?: number;
  now?: () => number;
  /** Strict chain mode (v6 §3.2-§3.9). OPTIONAL in the type so older harnesses compile; the runner ends with ok:false when one is missing. */
  jobSpend?: () => Promise<{ usd: number; calls: number }>;
  leaseHeld?: () => Promise<boolean>;
  jobStartedAtMs?: () => Promise<number>;
  tregCall?: (options: TregCallOptions) => Promise<TregCallResult>;
  newAttemptId?: () => string;
}


export interface ChainCandidate { n: string; u: string; i?: string; l?: string; d?: string }

export interface ChainCursor {
  v: 1;
  /** Billed discovery calls and enrichment calls so far in the whole job. */
  dc: number;
  ec: number;
  /** Candidates taken so far (all chunks) and the ones still to read. */
  taken: number;
  rest: ChainCandidate[];
  /** Company domains already seen (discovered): never taken twice. */
  seen: string[];
  /** The directory's own cursor when TREG discovery has more pages. */
  tc: string | null;
  /** Discovery cannot give more (exhausted, out of calls or out of providers). */
  dx: boolean;
  /** Rows delivered by earlier chunks (for the running total in the log lines). */
  out: number;
  /** Chunks in a row that read nothing and found nothing: three end the job. */
  ix: number;
}

const emptyCursor = (): ChainCursor => ({ v: 1, dc: 0, ec: 0, taken: 0, rest: [], seen: [], tc: null, dx: false, out: 0, ix: 0 });
export interface ChainCandidateV2 { n: string; u: string }
export interface ChainCursorV2 { v: 2; n: number; dc: number; ec: number; tp: number; out: number; ix: number; sq: number; uo: number; tr: number; wm: number; tg: number; dx: number; bd: number; tx: number; tf: number; aid: string; q: ChainCandidateV2[]; tc: string | null; tl: string | null; wq: Record<string, number>; ff: Record<string, number>; dn: string[]; cp: string[]; un: string[]; seen: string[] }
export const emptyCursorV2 = (aid = ""): ChainCursorV2 => ({ v: 2, n: 0, dc: 0, ec: 0, tp: 0, out: 0, ix: 0, sq: 0, uo: 0, tr: 0, wm: 0, tg: 0, dx: 0, bd: 0, tx: 0, tf: 0, aid, q: [], tc: null, tl: null, wq: {}, ff: {}, dn: [], cp: [], un: [], seen: [] });

export function encodeCursorV2(state: ChainCursorV2): { fits: true; cursor: string; state: ChainCursorV2 } | { fits: false; reason: "cursor_overflow" } {
  const copy: ChainCursorV2 = {
    ...state,
    q: [...state.q],
    wq: { ...state.wq },
    ff: { ...state.ff },
    dn: [...state.dn],
    cp: [...state.cp],
    un: [...state.un],
    seen: [...state.seen],
  };
  if (utf8Bytes(copy.q) > CHAIN_RUN.queueMaxBytes) {
    return { fits: false, reason: "cursor_overflow" };
  }
  if (typeof copy.tc === "string" && escapedBytes(copy.tc) > 512) {
    return { fits: false, reason: "cursor_overflow" };
  }
  if (typeof copy.tl === "string" && escapedBytes(copy.tl) > 512) {
    return { fits: false, reason: "cursor_overflow" };
  }
  while (utf8Bytes(copy) > CHAIN_RUN.cursorStateMaxBytes && copy.seen.length > 0) {
    copy.seen.pop();
    copy.tr = 1;
  }
  if (utf8Bytes(copy) > CHAIN_RUN.cursorStateMaxBytes) {
    return { fits: false, reason: "cursor_overflow" };
  }
  const cursor = Buffer.from(JSON.stringify(copy), "utf8").toString("base64url");
  if (cursor.length > CHAIN_RUN.cursorV2MaxChars) {
    return { fits: false, reason: "cursor_overflow" };
  }
  return { fits: true, cursor, state: copy };
}

export function decodeCursorAny(raw: string | null | undefined, aid: string): ChainCursorV2 {
  if (!raw || typeof raw !== "string" || !raw.trim()) {
    return emptyCursorV2(aid);
  }
  let parsed: any;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    return emptyCursorV2(aid);
  }
  if (!parsed || typeof parsed !== "object") {
    return emptyCursorV2(aid);
  }

  const clampInt = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.min(9999999999, Math.floor(x))) : 0);
  const clampFlag = (x: unknown): number => (x === 1 || x === true ? 1 : 0);
  const validProviders = new Set(["treg", "firecrawl", "contextdev"]);

  if (parsed.v === 2) {
    const q: ChainCandidateV2[] = Array.isArray(parsed.q)
      ? parsed.q
          .filter((c: any) => c && typeof c.n === "string" && typeof c.u === "string")
          .map((c: any) => ({ n: c.n, u: c.u }))
      : [];
    const wq: Record<string, number> = {};
    if (parsed.wq && typeof parsed.wq === "object") {
      for (const [k, v] of Object.entries(parsed.wq)) {
        if (validProviders.has(k)) wq[k] = clampInt(v);
      }
    }
    const ff: Record<string, number> = {};
    const validFfKeys = new Set(["treg", "firecrawl", "contextdev", "tregmail"]);
    if (parsed.ff && typeof parsed.ff === "object") {
      for (const [k, v] of Object.entries(parsed.ff)) {
        if (validFfKeys.has(k)) ff[k] = clampInt(v);
      }
    }
    const filterProv = (arr: unknown): string[] => (Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string" && validProviders.has(x)) : []);
    const seen = Array.isArray(parsed.seen) ? parsed.seen.filter((x: any): x is string => typeof x === "string") : [];

    return {
      v: 2,
      n: clampInt(parsed.n),
      dc: clampInt(parsed.dc),
      ec: clampInt(parsed.ec),
      tp: clampInt(parsed.tp),
      out: clampInt(parsed.out),
      ix: clampInt(parsed.ix),
      sq: clampInt(parsed.sq),
      uo: clampInt(parsed.uo),
      tr: clampFlag(parsed.tr),
      wm: clampInt(parsed.wm),
      tg: clampFlag(parsed.tg),
      dx: clampFlag(parsed.dx),
      bd: clampFlag(parsed.bd),
      tx: clampFlag(parsed.tx),
      tf: clampFlag(parsed.tf),
      aid,
      q,
      tc: typeof parsed.tc === "string" ? parsed.tc : null,
      tl: typeof parsed.tl === "string" ? parsed.tl : null,
      wq,
      ff,
      dn: filterProv(parsed.dn),
      cp: filterProv(parsed.cp),
      un: filterProv(parsed.un),
      seen,
    };
  }

  if (parsed.v === 1) {
    let uo = 0;
    const q: ChainCandidateV2[] = [];
    if (Array.isArray(parsed.rest)) {
      for (const c of parsed.rest) {
        if (!c || typeof c.u !== "string" || !ORIGIN_CHARSET_RE.test(c.u)) {
          uo++;
          continue;
        }
        const n = stripControl(String(c.n ?? "")).slice(0, 120);
        if (!n) {
          uo++;
          continue;
        }
        q.push({ n, u: c.u });
      }
    }
    const seen: string[] = [];
    if (Array.isArray(parsed.seen)) {
      for (const s of parsed.seen) {
        if (typeof s === "string" && HOST_RE.test(s)) {
          seen.push(s);
        } else {
          uo++;
        }
      }
    }
    return {
      v: 2,
      n: 0,
      dc: clampInt(parsed.dc),
      ec: clampInt(parsed.ec),
      tp: clampInt(parsed.taken),
      out: clampInt(parsed.out),
      ix: clampInt(parsed.ix),
      sq: 0,
      uo,
      tr: 0,
      wm: 0,
      tg: 0,
      dx: clampFlag(parsed.dx),
      bd: 0,
      tx: 0,
      tf: 0,
      aid,
      q,
      tc: typeof parsed.tc === "string" ? parsed.tc : null,
      tl: null,
      wq: {},
      ff: {},
      dn: [],
      cp: [],
      un: [],
      seen,
    };
  }

  return emptyCursorV2(aid);
}

export function admitBatch(state: ChainCursorV2, candidates: ChainCandidate[]): { admitted: boolean } {
  if (candidates.length > CHAIN_RUN.queueBatchMax) {
    state.tf = 1;
    return { admitted: false };
  }
  const queueDomains = new Set(state.q.map((item) => companyDomain(item.u)).filter((d): d is string => d !== null));
  const seenSet = new Set(state.seen);
  const localDomains = new Set<string>();
  const localList: ChainCandidateV2[] = [];
  const newSeen: string[] = [];

  for (const c of candidates) {
    const domain = companyDomain(c.u);
    if (domain === null || seenSet.has(domain) || queueDomains.has(domain) || localDomains.has(domain)) {
      continue;
    }
    if (!ORIGIN_CHARSET_RE.test(c.u) || !HOST_RE.test(domain)) {
      state.uo += 1;
      continue;
    }
    const cleaned = stripControl(cleanCompanyName(c.n)).slice(0, 120);
    if (!cleaned.trim()) {
      state.uo += 1;
      continue;
    }
    localList.push({ n: cleaned, u: c.u });
    newSeen.unshift(domain);
    localDomains.add(domain);
  }

  const wouldBe: ChainCursorV2 = {
    ...state,
    q: [...state.q, ...localList],
    seen: [...newSeen, ...state.seen],
    tp: state.tp + localList.length,
  };

  const enc = encodeCursorV2(wouldBe);
  if (!enc.fits || utf8Bytes(wouldBe.q) > CHAIN_RUN.queueMaxBytes) {
    state.tf = 1;
    return { admitted: false };
  }

  state.q = enc.state.q;
  state.seen = enc.state.seen;
  state.tp = wouldBe.tp;
  state.tr = enc.state.tr;
  return { admitted: true };
}

export interface ChainRunCtx { input: ChainChunkInput; deps: ChainDeps; params: ChainParams; route: RouteDef; budget: number; state: ChainCursorV2; attemptId: string; now: () => number; deadlineMs: number; hardEndMs: number; usd: number; calls: number; limits: { maxCalls: number; maxChunks: number; maxWallMs: number }; chunkCalls: number; chunkUsd: number; ordinal: number; trace: ChunkTraceCollector; stop: { spendUnreadable: boolean; ledger: boolean; workLimit: boolean; leaseLost: boolean; clockUnreadable: boolean; cursorOverflow: boolean }; rows: Record<string, any>[]; read: number; unverified: number; skipped: number; discoveredNow: number; fail: (messageAr: string, errorCode: string) => ProviderAdapterCallOutput }

export function verifyingRecorder(rc: ChainRunCtx): CallRecorder {
  return {
    reserve: async (args) => {
      const res = await rc.deps.recorder.reserve(args);
      if (!res.allowed) return res;

      const release = async () => {
        try {
          await rc.deps.recorder.commit(res.costId, {
            provider: args.provider,
            capabilityId: args.capabilityId,
            status: "failed",
            units: 0,
            costUsd: 0,
            durationMs: 0,
            jobId: args.jobId,
          } as CallRecord);
        } catch {
          // best effort
        }
      };

      let spend: { usd: number; calls: number };
      try {
        if (!rc.deps.jobSpend) throw new Error("jobSpend_missing");
        spend = await rc.deps.jobSpend();
      } catch {
        await release();
        rc.stop.spendUnreadable = true;
        return { allowed: false, costId: null, reason: "error" };
      }

      rc.usd = spend.usd;
      rc.calls = spend.calls;

      if (spend.usd > rc.budget + 1e-9) {
        await release();
        return { allowed: false, costId: null, reason: "budget" };
      }
      if (spend.calls > rc.limits.maxCalls) {
        await release();
        rc.stop.workLimit = true;
        return { allowed: false, costId: null, reason: "budget" };
      }

      rc.chunkCalls += 1;
      return res;
    },
    commit: async (costId, record) => {
      return rc.deps.recorder.commit(costId, record);
    },
  };
}

export async function canStartCall(rc: ChainRunCtx, maxUsd: number): Promise<"ok" | "time" | "chunk_calls" | "lease" | "budget"> {
  if (rc.now() >= rc.deadlineMs - CHAIN_RUN.noCallBeforeEndMs) {
    return "time";
  }
  if (rc.chunkCalls >= CHAIN_RUN.chunkCalls) {
    return "chunk_calls";
  }
  let held = false;
  try {
    if (rc.deps.leaseHeld) {
      held = await rc.deps.leaseHeld();
    }
  } catch {
    held = false;
  }
  if (!held) {
    rc.stop.leaseLost = true;
    return "lease";
  }
  if (rc.usd + maxUsd > rc.budget + 1e-9) {
    return "budget";
  }
  return "ok";
}

export function chainCtxFor(rc: ChainRunCtx, provider: DataProviderId): AdapterContext {
  const timeout = Math.max(1000, Math.min(PROVIDER_FACTS[provider].callTimeoutMs, rc.hardEndMs - rc.now()));
  return {
    apiKey: rc.deps.providerKeys[provider] ?? "",
    fetchFn: rc.deps.fetchFn,
    recorder: verifyingRecorder(rc),
    jobId: rc.input.jobId,
    now: rc.now,
    chainStrict: true,
    timeoutMs: timeout,
    timeoutCapMs: timeout,
  };
}

export async function oneTregDirectoryAsk(rc: ChainRunCtx, kind: "dir" | "dirkw"): Promise<{ called: boolean; answered: boolean; zeroRows: boolean }> {
  rc.ordinal += 1;
  const key = buildTregIdempotencyKey({ jobId: rc.input.jobId, attemptId: rc.attemptId, ordinal: rc.ordinal, kind });
  const timeoutMs = Math.min(CHAIN_RUN.tregTimeoutCapMs, Math.floor((rc.hardEndMs - rc.now()) / (1 + CHAIN_RUN.tregKeyPoolHops)));
  if (timeoutMs < CHAIN_RUN.tregMinTimeoutMs) {
    return { called: false, answered: false, zeroRows: false };
  }
  const gate = await canStartCall(rc, TREG_DIRECTORY.reservedUsd);
  if (gate !== "ok") {
    if (gate === "budget") rc.state.bd = 1;
    return { called: false, answered: false, zeroRows: false };
  }
  const rawParams = {
    industry: rc.params.industry,
    country: rc.params.country,
    location: rc.params.country,
    query: { keyword: { include: [rc.params.keyword, rc.params.industry].filter((x): x is string => typeof x === "string" && Boolean(x)) } },
  };
  const cursor = kind === "dirkw"
    ? (typeof rc.state.tc === "string" && rc.state.tc.startsWith(KEYWORDS_ONLY_CURSOR_PREFIX) ? rc.state.tc.slice(KEYWORDS_ONLY_CURSOR_PREFIX.length) : (typeof rc.state.tc === "string" ? rc.state.tc : null))
    : (typeof rc.state.tc === "string" && !rc.state.tc.startsWith(KEYWORDS_ONLY_CURSOR_PREFIX) ? rc.state.tc : null);

  const out = await runTregDirectoryPageDirect({
    tregCall: rc.deps.tregCall,
    ctx: { recorder: verifyingRecorder(rc), jobId: rc.input.jobId, now: rc.deps.now },
    userId: rc.input.userId,
    rawParams,
    cursor,
    keywordsOnly: kind === "dirkw",
    idempotencyKey: key,
    timeoutMs,
  });

  rc.chunkUsd += out.committedUsd;
  if (out.refused === undefined) {
    rc.state.dc += 1;
  }
  if (out.refused === "cap_reached") {
    if (!rc.state.cp.includes("treg")) rc.state.cp.push("treg");
  } else if (out.refused === "budget_reached") {
    rc.state.bd = 1;
  } else if (out.refused === "ledger_unavailable") {
    rc.stop.ledger = true;
  }

  if (!out.ok && out.refused === undefined) {
    rc.state.ff.treg = (rc.state.ff.treg ?? 0) + 1;
    if (rc.state.ff.treg >= CHAIN_RUN.downAfterFailures && !rc.state.dn.includes("treg")) {
      rc.state.dn.push("treg");
    }
  }

  if (out.ok) {
    rc.state.ff.treg = 0;
    const candidates = candidatesFromDirectory(out.rows);
    const prevTc = rc.state.tc;
    const prevTl = rc.state.tl;
    const prevTx = rc.state.tx;
    if (out.nextCursor && (out.nextCursor === rc.state.tc || out.nextCursor === rc.state.tl || escapedBytes(out.nextCursor) > CHAIN_RUN.tregCursorMaxEscapedBytes)) {
      rc.state.tf = 1;
    } else {
      rc.state.tl = rc.state.tc;
      rc.state.tc = out.nextCursor ? (kind === "dirkw" ? KEYWORDS_ONLY_CURSOR_PREFIX + out.nextCursor : out.nextCursor) : null;
      if (!out.nextCursor) {
        rc.state.tx = 1;
      }
    }
    const adm = admitBatch(rc.state, candidates);
    if (!adm.admitted) {
      rc.state.tc = prevTc;
      rc.state.tl = prevTl;
      rc.state.tx = prevTx;
    }
  }

  rc.trace.call("discover", "treg", "treg.companies.search", { status: out.status, costUsd: out.committedUsd, durationMs: out.durationMs });
  return { called: true, answered: out.ok, zeroRows: out.ok && out.rows.length === 0 };
}

export async function askTregDirectory(rc: ChainRunCtx): Promise<void> {
  const kw = typeof rc.state.tc === "string" && rc.state.tc.startsWith(KEYWORDS_ONLY_CURSOR_PREFIX);
  const first = await oneTregDirectoryAsk(rc, kw ? "dirkw" : "dir");

  const rawParams = {
    industry: rc.params.industry,
    country: rc.params.country,
    location: rc.params.country,
    query: { keyword: { include: [rc.params.keyword, rc.params.industry].filter((x): x is string => typeof x === "string" && Boolean(x)) } },
  };

  const normalParsed = normalizeIcypeasCompanyParams(rawParams, 10, null);
  const kwParsed = normalizeIcypeasCompanyParams(rawParams, 10, null, { keywordsOnly: true });

  if (
    first.called &&
    first.zeroRows &&
    !kw &&
    rc.state.tc === null &&
    rc.state.tx === 1 &&
    Boolean(normalParsed.query?.industry) &&
    (kwParsed.query?.keyword?.include?.length ?? 0) > 0 &&
    !kwParsed.query?.industry
  ) {
    rc.state.tx = 0;
    await oneTregDirectoryAsk(rc, "dirkw");
  }
}

export async function askWebVariant(rc: ChainRunCtx, provider: "firecrawl" | "contextdev"): Promise<void> {
  const cap = capabilityById(provider === "firecrawl" ? "firecrawl.search" : "contextdev.search") as CapabilityDef;
  const i = rc.state.wq[provider] ?? 0;
  if (i >= CHAIN_RUN.variantsPerProvider) return;
  const maxUsd = (cap.costPerCallUsd ?? 0) * Math.ceil(CHAIN_RUN.webAskLimit / (cap.unitsPerCall ?? 10));
  const gate = await canStartCall(rc, maxUsd);
  if (gate !== "ok") {
    if (gate === "budget") rc.state.bd = 1;
    return;
  }
  const queueHosts: string[] = [];
  for (const c of rc.state.q) {
    const d = companyDomain(c.u);
    if (d && !queueHosts.includes(d)) queueHosts.push(d);
  }
  const seenAndQueue: string[] = [];
  for (const h of [...rc.state.seen, ...queueHosts]) {
    if (h && !seenAndQueue.includes(h)) seenAndQueue.push(h);
  }
  const exclude = [...SOCIAL_EXCLUDE, ...seenAndQueue].slice(0, CHAIN_RUN.excludeDomainsMax);
  const res: OperationResult<SearchHit[]> = await ADAPTERS[provider].run(
    "discover.web_search",
    {
      query: discoveryQueryVariants(rc.params)[i],
      limit: CHAIN_RUN.webAskLimit,
      country: rc.params.countryIso ?? (rc.params.country && /^[A-Za-z]{2}$/.test(rc.params.country) ? rc.params.country : undefined),
      excludeDomains: exclude,
    },
    chainCtxFor(rc, provider),
  );

  if (res.errorCode === "cap_reached") {
    if (!rc.state.cp.includes(provider)) rc.state.cp.push(provider);
    return;
  }
  if (res.errorCode === "budget_reached") {
    rc.state.bd = 1;
    return;
  }
  if (res.errorCode === "ledger_unavailable") {
    rc.stop.ledger = true;
    return;
  }

  rc.state.wq[provider] = i + 1;
  rc.state.sq += 1;
  rc.state.dc += 1;
  rc.chunkUsd += res.costUsd;

  if (!res.ok) {
    rc.state.ff[provider] = (rc.state.ff[provider] ?? 0) + 1;
    if (rc.state.ff[provider] >= CHAIN_RUN.downAfterFailures && !rc.state.dn.includes(provider)) {
      rc.state.dn.push(provider);
    }
  } else {
    rc.state.ff[provider] = 0;
    const candidates = candidatesFromSearch(res.data ?? []);
    const adm = admitBatch(rc.state, candidates);
    if (!adm.admitted) {
      rc.state.tf = 1;
    }
  }

  rc.trace.call("discover", provider, cap.id, { status: res.status, costUsd: res.costUsd, durationMs: res.durationMs });
}

export async function discoverOnce(rc: ChainRunCtx): Promise<void> {
  const stage = rc.route.stages.find((s) => s.stage === "discover");
  if (!stage) return;
  const caps = stage.capabilityIds.map(capabilityById);
  for (const cap of caps) {
    const provider = cap.provider;
    const isUnusable =
      !rc.deps.providerKeys[provider] ||
      !isSellable(cap) ||
      (provider === "treg" && !rc.deps.tregCall);
    if (isUnusable) {
      if (!rc.state.un.includes(provider)) rc.state.un.push(provider);
      continue;
    }
    if (rc.state.dn.includes(provider) || rc.state.cp.includes(provider)) {
      continue;
    }
    const isOver =
      provider === "treg"
        ? rc.state.tx === 1 || rc.state.tf === 1
        : (rc.state.wq[provider] ?? 0) >= CHAIN_RUN.variantsPerProvider;
    if (isOver) {
      continue;
    }

    const beforeTp = rc.state.tp;
    if (provider === "treg") {
      await askTregDirectory(rc);
    } else {
      await askWebVariant(rc, provider);
    }
    const admitted = rc.state.tp - beforeTp;
    rc.discoveredNow = admitted;
    if (admitted > 0) {
      await rc.deps.emit(discoveryLineAr({ found: admitted, fresh: admitted, duplicate: 0, total: rc.state.tp }), rc.state.out);
    } else {
      await rc.deps.emit(discoveryEmptyLineAr(), rc.state.out);
    }
    return;
  }
  rc.state.dx = 1;
}










const MAX_CURSOR_CHARS = 8000;
export const MAX_STARTS_PER_STEP = 8;
export const CHAIN_RUN = { chunkCalls: 24, variantsPerProvider: 8, queueBatchMax: 20, stallChunks: 3, downAfterFailures: 3, wasteBreakerMisses: 8, leaseMarginMs: 3000, noCallBeforeEndMs: 5000, noCompanyBeforeEndMs: 15000, hardEndAfterDeadlineMs: 5000, tregTimeoutCapMs: 10000, tregMinTimeoutMs: 2000, tregKeyPoolHops: 3, wallClockMs: 6 * 60 * 60 * 1000, cursorStateMaxBytes: 30000, cursorV2MaxChars: 40000, queueMaxBytes: 12000, tregCursorMaxEscapedBytes: 512, webAskLimit: 20, webQueryMaxChars: 300, excludeDomainsMax: 100, lookupFailuresOff: 3 } as const;
export const DISCOVERY_SUFFIX = ["", "contact us", "about us", "management team", "head office", "group", "profile", "services"] as const;

export function encodeChainCursor(state: ChainCursor): string {
  const trimmed: ChainCursor = { ...state, seen: [...state.seen], rest: [...state.rest] };
  const encode = () => Buffer.from(JSON.stringify(trimmed), "utf8").toString("base64url");
  let encoded = encode();
  // The cursor is stored in the job row: keep it small (the size that counts is the encoded one, and Arabic takes two bytes a letter).
  // The oldest seen domains go first, then the tail of the waiting list.
  while (encoded.length > MAX_CURSOR_CHARS && trimmed.seen.length > 20) { trimmed.seen = trimmed.seen.slice(Math.ceil(trimmed.seen.length / 4)); encoded = encode(); }
  while (encoded.length > MAX_CURSOR_CHARS && trimmed.rest.length > 5) { trimmed.rest = trimmed.rest.slice(0, trimmed.rest.length - 5); encoded = encode(); }
  return encoded;
}

export function decodeChainCursor(raw: string | null | undefined): ChainCursor {
  if (!raw) return emptyCursor();
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (parsed?.v !== 1) return emptyCursor();
    return {
      v: 1,
      dc: Math.max(0, Number(parsed.dc) || 0),
      ec: Math.max(0, Number(parsed.ec) || 0),
      taken: Math.max(0, Number(parsed.taken) || 0),
      rest: Array.isArray(parsed.rest) ? parsed.rest.filter((c: any) => c && typeof c.u === "string").slice(0, 120) : [],
      seen: Array.isArray(parsed.seen) ? parsed.seen.filter((s: unknown) => typeof s === "string").slice(-600) : [],
      tc: typeof parsed.tc === "string" ? parsed.tc : null,
      dx: Boolean(parsed.dx),
      out: Math.max(0, Number(parsed.out) || 0),
      ix: Math.max(0, Number(parsed.ix) || 0),
    };
  } catch {
    return emptyCursor();
  }
}

/** What the plan item stores for the chain (the worker passes it back as spec.params). */
export interface ChainParams {
  /** The opaque code of the route (see routeCodeOf): the plan item never carries the route id. */
  routeCode: string;
  industry?: string;
  country?: string;
  keyword?: string;
  /** Two-letter country code for the web searches (the directory takes the English name in `country`). */
  countryIso?: string;
  /** The customer's own Arabic words for the activity and the country: what the delivered rows say (never sent to a provider). */
  industryAr?: string;
  countryAr?: string;
  requiredFields: RequiredField[];
  count: number;
}

export function chainParamsOf(params: Record<string, any> | undefined): ChainParams | null {
  const p = params || {};
  const route = routeByCode(p.routeCode);
  if (!route || route.kind !== "chain") return null;
  const required = Array.isArray(p.requiredFields) ? p.requiredFields.filter((f: unknown): f is RequiredField => f === "work_email" || f === "office_phone" || f === "profile_link" || f === "decision_maker") : [];
  return {
    routeCode: p.routeCode,
    industry: typeof p.industry === "string" ? p.industry : undefined,
    country: typeof p.country === "string" ? p.country : undefined,
    keyword: typeof p.keyword === "string" ? p.keyword : undefined,
    countryIso: typeof p.countryIso === "string" && /^[A-Za-z]{2}$/.test(p.countryIso) ? p.countryIso : undefined,
    industryAr: typeof p.industryAr === "string" ? p.industryAr.slice(0, 80) : undefined,
    countryAr: typeof p.countryAr === "string" ? p.countryAr.slice(0, 60) : undefined,
    requiredFields: required,
    count: Math.max(1, Math.floor(Number(p.count) || 1)),
  };
}

const SOCIAL_EXCLUDE = ["facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "tiktok.com", "youtube.com", "pinterest.com", "reddit.com", "wikipedia.org"];
const DIRECTORY_NOISE = /(?:yellowpages|yelp|tripadvisor|booking|amazon|alibaba|indeed|glassdoor|crunchbase|zoominfo|dnb|clutch|trustpilot|forbes|bloomberg)\./i;

/** The first heading (or the first line) of a page's markdown, as plain text. */
function firstHeadingOf(markdown: string): string {
  const text = String(markdown || "");
  const heading = /^\s{0,3}#{1,2}\s+(.+)$/m.exec(text)?.[1];
  return cleanMarkdownText(heading ?? text.split(/\r?\n/).find((line) => line.trim()) ?? "").slice(0, 200);
}

export function buildDiscoveryQuery(params: ChainParams): string {
  return [params.keyword, params.industry, params.country, "company official website"].filter((p) => typeof p === "string" && p.trim()).join(" ").slice(0, 300);
}

export function discoveryQueryVariants(params: ChainParams): string[] {
  const list: string[] = [buildDiscoveryQuery(params)];
  for (let i = 1; i <= 7; i++) {
    list.push([params.keyword, params.industry, params.country, DISCOVERY_SUFFIX[i]].filter((s): s is string => typeof s === "string" && s.trim().length > 0).join(" ").slice(0, CHAIN_RUN.webQueryMaxChars));
  }
  return list;
}

export function workLimitsFor(count: number, requiredFields: RequiredField[], discoverCapId: string): { maxCalls: number; maxChunks: number; maxWallMs: number } {
  const websiteShare = YIELD.websiteShare[discoverCapId] ?? 0.5;
  const verified = verifiedShareFor(requiredFields);
  const dprRaw = websiteShare * verified;
  const dpr = dprRaw > 0 ? dprRaw : 0.01;
  const results = Math.ceil(count / dpr - 1e-9);
  const needCand = Math.ceil(results * websiteShare - 1e-9);
  const needsDM = requiredFields.includes("decision_maker");
  const needsContact = requiredFields.includes("work_email") || requiredFields.includes("office_phone");
  const plainPages = needsContact || !needsDM ? YIELD.pagesPerCompany : 1;
  const pages = plainPages + (needsDM ? 1 : 0);
  const lookupCalls = 1;
  const readCalls = needCand * (lookupCalls + pages);
  const askCalls = Math.ceil(needCand / 5);
  const maxCalls = 3 * (readCalls + askCalls) + 3 * (2 * 8 + 40);
  return { maxCalls, maxChunks: 21 * maxCalls + 3, maxWallMs: 6 * 60 * 60 * 1000 };
}



function nameFromTitle(title: string, host: string): string {
  // «Utopia Pharmaceutical: Home» is «Utopia Pharmaceutical»; markdown symbols never stay in a name (see companyRowHygiene).
  return cleanCompanyName(title, host);
}

/** A search hit becomes a candidate only if it is a public company homepage-like page: not a social network, not a directory or media site, not a login page. */
export function candidatesFromSearch(hits: SearchHit[]): ChainCandidate[] {
  const out: ChainCandidate[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (!checkPublicBusinessUrl(hit.url).ok) continue;
    // A list, a ranking, a directory or an article about companies is not a company («Top 40 Pharmaceutical Companies…»): no page is read for it.
    if (nonCompanyReasonAr({ title: hit.title, url: hit.url })) continue;
    const domain = companyDomain(hit.url);
    if (!domain || seen.has(domain) || DIRECTORY_NOISE.test(domain)) continue;
    seen.add(domain);
    let origin: string;
    try { origin = new URL(hit.url).origin; } catch { continue; }
    out.push({ n: nameFromTitle(hit.title || "", domain), u: origin, d: hit.description ? cleanMarkdownText(hit.description).slice(0, 200) : undefined });
  }
  return out;
}

export function candidatesFromDirectory(rows: Record<string, any>[]): ChainCandidate[] {
  const out: ChainCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const site = String(row?.website || row?.website_url || row?.domain || row?.company_website || "").trim();
    if (!site) continue;
    const url = /^https?:\/\//i.test(site) ? site : `https://${site}`;
    if (!checkPublicBusinessUrl(url).ok) continue;
    const domain = companyDomain(url);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    let origin: string;
    try { origin = new URL(url).origin; } catch { continue; }
    if (nonCompanyReasonAr({ title: row?.company_name || row?.name || row?.title })) continue;
    const name = cleanCompanyName(row?.company_name || row?.name || row?.title || domain, domain);
    out.push({ n: name, u: origin, i: typeof row?.industry === "string" ? row.industry.slice(0, 80) : undefined, l: typeof row?.location === "string" ? row.location.slice(0, 80) : typeof row?.country === "string" ? row.country.slice(0, 60) : undefined, d: typeof row?.description === "string" ? cleanMarkdownText(row.description).slice(0, 200) : undefined });
  }
  return out;
}

type ReadResult = OperationResult<any> & { capId: string };

const TEAM_PROMPT = "List the people this page publicly lists as company leaders or owners, with their exact job titles. Return only what the page states.";
const TEAM_SCHEMA = { type: "object", properties: { people: { type: "array", items: { type: "object", properties: { name: { type: "string" }, title: { type: "string" } }, required: ["name", "title"] } } }, required: ["people"] };

export async function runChainChunk(input: ChainChunkInput, deps: ChainDeps): Promise<ProviderAdapterCallOutput & { chainStop?: ChainRunnerStop; attemptId?: string; chainSkippedOrigins?: number }> {
  const now = deps.now ?? Date.now;
  const fail = (messageAr: string, errorCode: string): ProviderAdapterCallOutput => ({ ok: false, httpStatus: 503, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "", errorCode, errorMessageAr: messageAr });

  const params = chainParamsOf(input.params);
  const route: RouteDef | undefined = params ? routeByCode(params.routeCode) : undefined;
  if (!params || !route) return fail("تعذر تحديد مسار جمع البيانات لهذا الطلب؛ حجز مؤقت مُحرَّر.", "chain_route_missing");

  // The job's final volume (the quote may have cut it to fit the cap) is what the chain works to; the plan's own count is only the first guess.
  if (Number.isFinite(input.targetVolumeMax) && input.targetVolumeMax > 0) params.count = Math.floor(input.targetVolumeMax);
  const request: RouteRequest = { industry: params.industry, country: params.country, keyword: params.keyword, count: params.count, requiredFields: params.requiredFields };
  const estimate = estimateRoute(route, request);
  const state = decodeChainCursor(input.cursor);
  const discoverStage = route.stages.find((s) => s.stage === "discover");
  const enrichStage = route.stages.find((s) => s.stage === "enrich");
  const maxDiscoverCalls = estimate.stages.find((s) => s.stage === "discover")?.maxCalls ?? 1;
  const maxEnrichCalls = estimate.stages.find((s) => s.stage === "enrich")?.maxCalls ?? 0;

  let chunkUsd = 0;
  const spentBefore = await deps.spentUsdSoFar().catch(() => 0);
  const trace = new ChunkTraceCollector(deps.step ?? 0, spentBefore);
  // The provider spend of the whole job may not pass the RESERVE the customer's points hold, expressed in provider cost: the reserve is
  // ceil(volume x unit price x 1.15) points and 5,500 points are the price of 1 USD of provider cost, so the budget is reserve / 5,500 USD
  // (the estimate plus the 15% buffer, rounded up with the whole-point price). Without a unit price the router's own estimate applies.
  const budget = Number(input.unitPricePoints) > 0 ? reserveForUnits(params.count, Number(input.unitPricePoints)) / 5500 : estimate.budgetUsd;
  const canAfford = (cap: CapabilityDef) => budget - spentBefore - chunkUsd + 1e-12 >= (cap.costPerCallUsd ?? Infinity);
  const usable = (cap: CapabilityDef | undefined): cap is CapabilityDef => Boolean(cap) && isSellable(cap) && Boolean(deps.providerKeys[(cap as CapabilityDef).provider]);
  const ctxFor = (provider: DataProviderId): AdapterContext => ({ apiKey: deps.providerKeys[provider] ?? "", fetchFn: deps.fetchFn, recorder: deps.recorder, jobId: input.jobId, now: deps.now });
  const track = (r: { costUsd: number }) => { chunkUsd += Math.max(0, r.costUsd || 0); };
  let budgetStop = false;

  // ---- DISCOVER -----------------------------------------------------------------------------------------------------------
  let discoveredNow = 0;
  if (state.rest.length === 0 && !state.dx && discoverStage) {
    const wanted = Math.max(0, estimate.candidates - state.taken);
    if (wanted <= 0 || state.dc >= maxDiscoverCalls) {
      state.dx = true;
    } else {
      const caps = discoverStage.capabilityIds.map(capabilityById).filter(usable);
      let got: ChainCandidate[] = [];
      let attempted = false;
      for (let k = 0; k < caps.length; k += 1) {
        const cap = caps[k];
        if (state.dc >= maxDiscoverCalls) break;
        if (!canAfford(cap)) { budgetStop = true; break; }
        attempted = true;
        state.dc += 1;
        let candidates: ChainCandidate[] = [];
        if (cap.provider === "treg") {
          const page = await runTregDirectoryPage({
            tregFn: deps.tregFn,
            input: { ...input, endpointId: "icypeas.companies.search", capabilitySlug: "icypeas-companies-search", method: "POST", paginationStrategy: "cursor", cursor: state.tc, pageSize: 10, params: { industry: params.industry, country: params.country, location: params.country, query: { keyword: { include: [params.keyword, params.industry].filter(Boolean) } } } },
            ctx: { recorder: deps.recorder, jobId: input.jobId, now: deps.now },
          });
          chunkUsd += page.costUsd;
          trace.call("discover", "treg", cap.id, { status: page.ok ? (page.rows.length > 0 ? "success" : "empty") : "failed", costUsd: page.costUsd, durationMs: 0 });
          if (page.ok && page.rows.length > 0) {
            candidates = candidatesFromDirectory(page.rows);
            state.tc = page.nextCursor;
            if (!page.nextCursor) state.dx = true;
          }
        } else {
          const limit = Math.min(HARD_LIMITS.maxDiscoveryResults, Math.max(10, estimate.discoveryResults));
          const res: OperationResult<SearchHit[]> = await ADAPTERS[cap.provider].run("discover.web_search", { query: buildDiscoveryQuery(params), limit, country: params.countryIso ?? (params.country && /^[A-Za-z]{2}$/.test(params.country) ? params.country : undefined), excludeDomains: SOCIAL_EXCLUDE }, ctxFor(cap.provider));
          track(res);
          trace.call("discover", cap.provider, cap.id, { status: res.status, costUsd: res.costUsd, durationMs: res.durationMs });
          if (res.ok && res.data && res.data.length > 0) {
            candidates = candidatesFromSearch(res.data);
            state.dx = true; // a search is one answer: it has no next page
          }
        }
        if (candidates.length > 0) { got = candidates; break; }
        // This provider failed or gave nothing usable: the next allowed one for the stage.
        trace.fallback({ stage: "discover", fromCapabilityId: cap.id, toCapabilityId: caps[k + 1]?.id ?? null, reason: "no_usable_results" });
        if (k < caps.length - 1) await deps.emit(stageFallbackLineAr(), state.out);
        state.dx = false;
      }
      if (!attempted && !budgetStop) state.dx = true;
      const seen = new Set(state.seen);
      const unseen = got.filter((c) => { const d = companyDomain(c.u); return d !== null && !seen.has(d); });
      const fresh = unseen.slice(0, wanted);
      for (const c of fresh) { const d = companyDomain(c.u); if (d) { seen.add(d); state.seen.push(d); } }
      state.rest.push(...fresh);
      state.taken += fresh.length;
      discoveredNow = fresh.length;
      if (got.length > 0 && fresh.length >= 0) {
        // The stage that delivered the candidates is the last one that was tried and answered.
        const delivering = [...caps].reverse().find((c) => (trace.peek("discover", c.id)?.success ?? 0) > 0);
        const t = delivering ? trace.peek("discover", delivering.id) : undefined;
        if (delivering && t) { t.found += got.length; t.fresh += fresh.length; t.duplicate += got.length - unseen.length; }
      }
      if (attempted) {
        if (got.length > 0) await deps.emit(discoveryLineAr({ found: got.length, fresh: fresh.length, duplicate: got.length - unseen.length, total: state.taken }), state.out);
        else { await deps.emit(discoveryEmptyLineAr(), state.out); if (state.tc === null) state.dx = true; }
      }
      // Providers answered with nothing new and there is no further page: discovery is over.
      if (got.length > 0 && fresh.length === 0 && state.tc === null) state.dx = true;
      if (caps.length > 0 && got.length === 0 && state.dc >= maxDiscoverCalls) state.dx = true;
    }
  }

  // ---- ENRICH + VERIFY ----------------------------------------------------------------------------------------------------
  const rows: Record<string, any>[] = [];
  let read = 0;
  let unverified = 0;
  let skipped = 0;
  const robotsCache = new Map<string, RobotsRules | "none" | "unreadable">();
  const perChunkLimit = Math.max(1, Math.floor(PROVIDER_FACTS.firecrawl.maxCallsPerChunk / YIELD.pagesPerCompany));
  const queue = state.rest.splice(0, perChunkLimit);
  const deadline = input.deadlineMs ?? now() + 40_000;
  const leftover: ChainCandidate[] = [];

  /** Reads a page with the stage's providers in order. "blocked" means the SITE refused: no other provider is tried. */
  const readPage = async (url: string, structured = false): Promise<ReadResult | "blocked" | null> => {
    let failed: CapabilityDef | null = null;
    let failedReason = "";
    const closeFallback = (to: CapabilityDef | null) => { if (failed) { trace.fallback({ stage: "enrich", fromCapabilityId: failed.id, toCapabilityId: to?.id ?? null, reason: failedReason }); failed = null; } };
    for (const capId of enrichStage?.capabilityIds ?? []) {
      const base = capabilityById(capId);
      const cap = structured && base ? capabilityById(base.provider === "firecrawl" ? "firecrawl.scrape_json" : "contextdev.scrape_json") : base;
      if (!usable(cap)) continue;
      if (state.ec >= maxEnrichCalls) { closeFallback(null); return null; }
      if (!canAfford(cap)) { budgetStop = true; closeFallback(null); return null; }
      closeFallback(cap);
      state.ec += 1;
      const adapter = ADAPTERS[cap.provider];
      const res: OperationResult<any> = structured
        ? await adapter.run("page.read_structured", { url, prompt: TEAM_PROMPT, schema: TEAM_SCHEMA }, ctxFor(cap.provider))
        : await adapter.run("page.read", { url }, ctxFor(cap.provider));
      track(res);
      trace.call("enrich", cap.provider, cap.id, { status: res.status, costUsd: res.costUsd, durationMs: res.durationMs });
      if (res.ok && res.status !== "empty") return Object.assign(res, { capId: cap.id });
      if (res.errorCode === "blocked_site") return "blocked";
      // not found / refused request: another provider would get the same answer. Anything else (a timeout, a busy provider, an empty page, a cap) tries the next provider.
      if (res.errorCode === "not_found" || res.errorCode === "bad_request") return null;
      failed = cap;
      failedReason = res.errorCode ?? "empty";
    }
    closeFallback(null);
    return null;
  };

  const TEAM_URL = /team|leadership|management|about|people|founder|الفريق|الإدارة|من-?نحن/i;
  const readableUrl = (u: string) => { try { return decodeURIComponent(u); } catch { return u; } };

  const processCandidate = async (c: ChainCandidate): Promise<void> => {
    const domain = companyDomain(c.u);
    if (!domain || !checkPublicBusinessUrl(c.u).ok) { skipped += 1; return; }
    if (!(await checkRobots(`${c.u}/`, deps.robotsFetch, robotsCache)).allowed) { skipped += 1; return; }
    const first = await readPage(c.u);
    if (first === "blocked") { skipped += 1; return; }
    read += 1;
    const servedBy = first ? capabilityById(first.capId) : undefined;
    const enrichTrace = () => trace.stage("enrich", servedBy?.provider ?? null, servedBy?.id ?? null);
    if (!first) { unverified += 1; return; }
    enrichTrace().read += 1;
    const homeData = first.data as { markdown: string; links: string[] };
    // The page behind a company's address turned out to be a list or an article (its own first heading says so): not a company, not delivered, not charged.
    if (isListOrArticleTitle(firstHeadingOf(homeData.markdown))) { unverified += 1; trace.stage("verify", null, null).unverified += 1; return; }
    let links = [...(homeData.links || []), ...linksFromMarkdown(homeData.markdown)];
    const emails: FoundEmail[] = extractEmails(homeData.markdown, links, domain);
    const countryIso = params.countryIso ?? (params.country ? isoCountryCodeFromName(params.country) : undefined);
    // A number whose international prefix is another country's is not verified as this company's phone.
    let phones: FoundPhone[] = markForeignPhones(extractPhones(homeData.markdown, links), countryIso);
    let profile = extractProfileLink(homeData.markdown, links);
    let sourcePage = c.u;
    const needEmail = params.requiredFields.includes("work_email");
    const needPhone = params.requiredFields.includes("office_phone");
    const needDm = params.requiredFields.includes("decision_maker");
    // A people-only request needs no contact page: the team page is the one to read.
    const contactNeeded = needEmail || needPhone || !needDm;
    const enough = () => !contactNeeded || ((!needEmail || emails.some((e) => e.status === "verified")) && (!needPhone || phones.some((p) => p.status === "verified")) && (needEmail || needPhone || emails.length + phones.length > 0));
    if (!enough()) {
      for (const page of pickContactPages(links, c.u, YIELD.pagesPerCompany - 1)) {
        if (!(await checkRobots(page, deps.robotsFetch, robotsCache)).allowed) continue;
        const res = await readPage(page);
        if (!res || res === "blocked") continue;
        const d = res.data as { markdown: string; links: string[] };
        const more = [...(d.links || []), ...linksFromMarkdown(d.markdown)];
        links = [...links, ...more];
        for (const e of extractEmails(d.markdown, more, domain)) if (!emails.some((x) => x.value === e.value)) emails.push(e);
        for (const p of markForeignPhones(extractPhones(d.markdown, more), countryIso)) if (!phones.some((x) => x.value === p.value)) phones.push(p);
        profile = profile ?? extractProfileLink(d.markdown, more);
        sourcePage = page;
        if (enough()) break;
      }
    }
    let decisionMakers: DecisionMaker[] = [];
    if (needDm) {
      // The team page is looked for in the links of EVERY page read so far (the home page or a contact page may be the one that links it).
      const team = pickContactPages(links, c.u, 6).find((u) => TEAM_URL.test(readableUrl(u)));
      if (team && (await checkRobots(team, deps.robotsFetch, robotsCache)).allowed) {
        const res = await readPage(team, true);
        if (res && res !== "blocked") { decisionMakers = parseDecisionMakers((res.data as { json: unknown }).json); if (decisionMakers.length > 0) sourcePage = team; }
      }
    }
    const facts: EnrichmentFacts = { companyName: c.n, website: c.u, industry: c.i ?? params.industryAr ?? params.industry, location: c.l ?? params.countryAr ?? params.country, description: c.d, emails, phones, profileLink: profile, decisionMakers, sourcePage };
    const row = buildContactRow(facts);
    if (rowPassesGate(row, params.requiredFields)) { rows.push(row); trace.stage("verify", null, null).verified += 1; }
    else { unverified += 1; trace.stage("verify", null, null).unverified += 1; }
  };

  // Two companies at a time (both providers limit concurrent requests per plan); one company's own pages are read one after the other.
  let index = 0;
  const lane = async () => {
    while (index < queue.length) {
      const c = queue[index++];
      if (now() > deadline - 12_000 || budgetStop || state.ec >= maxEnrichCalls) { leftover.push(c); continue; }
      await processCandidate(c);
    }
  };
  if (enrichStage && queue.length > 0) await Promise.all(Array.from({ length: Math.min(PROVIDER_FACTS.firecrawl.maxConcurrentCalls, queue.length) }, lane));
  else leftover.push(...queue);
  state.rest.unshift(...leftover);

  const delivered = rows.slice(0, Math.max(0, input.remainingNeeded));
  state.out += delivered.length;
  if (read > 0 || delivered.length > 0) await deps.emit(enrichLineAr({ read, verified: delivered.length, unverified, total: state.out }), state.out);
  if (skipped > 0) await deps.emit(skippedSitesLineAr(skipped), state.out);

  const processedAny = read + skipped > 0 || discoveredNow > 0;
  state.ix = processedAny ? 0 : state.ix + 1;
  const noMoreWork = (state.rest.length === 0 && state.dx) || (state.rest.length > 0 && state.ec >= maxEnrichCalls) || state.ix >= 3;
  const finished = budgetStop || noMoreWork || input.deliveredSoFar + delivered.length >= params.count;
  if (finished) await deps.emit(chainStopProgressLineAr(budgetStop ? "budget" : input.deliveredSoFar + delivered.length >= params.count ? "target_reached" : "no_more_work"), state.out);

  const stoppedBy: ChunkTrace["stoppedBy"] = budgetStop ? "budget" : input.deliveredSoFar + delivered.length >= params.count ? "target_reached" : noMoreWork ? "no_more_work" : null;
  trace.stage("verify", null, null).skipped += skipped;
  if (deps.trace) await deps.trace(trace.finish({ at: new Date(now()).toISOString(), delivered: delivered.length, costUsd: chunkUsd, stoppedBy })).catch(() => {});

  return {
    ok: true,
    httpStatus: 200,
    rows: delivered,
    nextCursor: finished ? null : encodeChainCursor(state),
    costUsd: Math.round(chunkUsd * 1e6) / 1e6,
    costMicro: Math.round(chunkUsd * 1e6),
    tregCallId: "",
    ...(finished && stoppedBy ? { chainStop: stoppedBy } : {}),
  };
}
