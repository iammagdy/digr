import { MISSION_TABLE } from "../agentMission/constants";
import { WAITING_STATUSES, expireWaitingMissions, isExpiredMission, EXPIRED_SENTENCE_AR } from "./expiry";
import { failStuckPlanning, openMissionView } from "../agentMission/openMissions";
import { customerSafeText } from "../agentMission/text";
import { resolveRequestKind } from "../jobs/requestStatus";
import { customerFacingConversationTitle } from "../customerFacingConversationTitle";
import { getJobIdForQuote } from "../md5";
import { matchesSearch, searchTerms } from "./search";
import { REQUESTS_MAX_LIMIT, REQUESTS_PAGE_SIZE, tabOfKind, type RequestTab } from "./tabs";
import type { EndedKind, IndexRow, MissionIndexRow, PendingIndexRow, RequestIndex } from "./types";

/**
 * THE LIST OF «طلباتي», decided on the server: which requests exist, which tab each belongs to, which match the search, how many each tab holds, and which 20 come next. The page then reads the listed jobs for their files and points.
 *
 * A request is exactly one of:
 *   - a JOB (its tab from its status and delivered count: the same function the page uses for its chip), with the words of the request from its mission (agent requests) or the conversation it was asked in (older requests);
 *   - a MISSION that is not a job: queued / planning (running), cancelled / expired / failed / unserved (ended), or a question / plan waiting for the customer (the pending block, never in the list);
 *   - a mission that has a job is that job, never a second row.
 *
 * Nothing here touches money: it reads jobs and missions, and (through the same two calls the open-missions list makes) ends planning that lost its worker and expires unanswered questions and plans.
 */
const PAGE = 1000;
const MAX_ROWS = 5000;

async function readAll(make: (from: number, to: number) => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const res = await make(from, from + PAGE - 1);
    if (res?.error || !Array.isArray(res?.data)) break;
    out.push(...res.data);
    if (res.data.length < PAGE) break;
  }
  return out;
}

const oneLine = (t: unknown, n: number): string => { const s = String(t ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const ENDED_STATUSES = ["cancelled", "failed", "unserved"] as const;
const RUNNING_STATUSES = ["queued", "planning", "approved", "executing"] as const;
const RUNNING_NOTE_AR: Record<string, string> = { queued: "في الدور وتبدأ خلال دقائق", planning: "قيد الدراسة الآن", approved: "اعتُمدت وتبدأ خلال لحظات", executing: "قيد التنفيذ الآن" };
const ENDED_NOTE_AR: Record<EndedKind, string> = {
  cancelled: "ألغيت هذه المهمة قبل التنفيذ، ولم يُخصم منك شيء.",
  expired: `${EXPIRED_SENTENCE_AR}؛ لم تُعتمد خلال ٧٢ ساعة، ولم يُخصم منك شيء.`,
  failed: "تعذّر تجهيز هذه المهمة ولم يُخصم منك شيء.",
  unserved: "لم نتمكن من تلبية هذه المهمة ولم يُخصم منك شيء.",
};

/** The older requests have no request text of their own: the title of the conversation they were asked in (the same link the page makes), read only when there is a search to match. */
async function legacyTitles(client: any, userId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const [quotes, messages, conversations] = await Promise.all([
      readAll((a, b) => client.from("plans_quotes").select("id").eq("user_id", userId).eq("status", "accepted").order("created_at", { ascending: false }).range(a, b)),
      client.from("messages").select("conversation_id,quote").eq("user_id", userId).order("created_at", { ascending: false }).limit(2000),
      readAll((a, b) => client.from("conversations").select("id,title").eq("user_id", userId).order("updated_at", { ascending: false }).range(a, b)),
    ]);
    const titleOf = new Map<string, string>();
    for (const c of conversations) titleOf.set(String(c.id), customerFacingConversationTitle(String(c.title ?? "")));
    const convOfQuote = new Map<string, string>();
    for (const m of Array.isArray(messages?.data) ? messages.data : []) {
      const q = m?.quote?.quoteId || m?.quote?.id;
      if (q && m.conversation_id && !convOfQuote.has(String(q))) convOfQuote.set(String(q), String(m.conversation_id));
    }
    for (const q of quotes) {
      const conv = convOfQuote.get(String(q.id));
      const title = conv ? titleOf.get(conv) : null;
      if (title) out.set(getJobIdForQuote(String(q.id)), title);
    }
  } catch { /* the older requests are then found by nothing but their position */ }
  return out;
}

/** The conversation that holds each mission's card, for «افتحها»: one read of the customer's recent assistant messages. */
export async function conversationsOfMissions(client: any, userId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { data } = await client.from("messages").select("conversation_id,plan").eq("user_id", userId).eq("role", "assistant").order("created_at", { ascending: false }).limit(300);
    for (const row of Array.isArray(data) ? data : []) {
      const id = row?.plan?.agentMissionId;
      if (typeof id === "string" && row.conversation_id && !out.has(id)) out.set(id, String(row.conversation_id));
    }
  } catch { /* the request still opens by its id */ }
  return out;
}

export interface BuildIndexInput { userId: string; tab: RequestTab; q?: string; offset?: number; limit?: number; now?: number }

export async function buildRequestIndex(client: any, input: BuildIndexInput): Promise<RequestIndex> {
  const now = input.now ?? Date.now();
  const offset = Math.max(0, Math.floor(Number(input.offset) || 0));
  const limit = Math.min(REQUESTS_MAX_LIMIT, Math.max(1, Math.floor(Number(input.limit) || REQUESTS_PAGE_SIZE)));
  const terms = searchTerms(input.q);

  try { await failStuckPlanning(client, { userId: input.userId, now }); } catch { /* the list still reads */ }
  try { await expireWaitingMissions(client, { userId: input.userId, now }); } catch { /* the list still reads */ }

  const [jobs, missions] = await Promise.all([
    readAll((a, b) => client.from("jobs").select("id,status,delivered_units,target_volume_max,created_at").eq("user_id", input.userId).order("created_at", { ascending: false }).range(a, b)),
    readAll((a, b) => client.from(MISSION_TABLE).select("id,status,job_id,request_text,created_at,lease_until,summary_ar,error").eq("user_id", input.userId).order("created_at", { ascending: false }).range(a, b)),
  ]);

  const missionOfJob = new Map<string, any>();
  for (const m of missions) if (m.job_id) missionOfJob.set(String(m.job_id), m);
  const legacy = terms.length > 0 ? await legacyTitles(client, input.userId) : new Map<string, string>();

  const rows: Array<IndexRow & { text: string }> = [];
  for (const j of jobs) {
    const delivered = j.delivered_units ?? 0;
    const tab = tabOfKind(resolveRequestKind({ status: j.status, delivered, requested: typeof j.target_volume_max === "number" ? j.target_volume_max : undefined }));
    const mission = missionOfJob.get(String(j.id));
    const title = mission ? oneLine(mission.request_text, 200) : null;
    rows.push({ type: "job", id: String(j.id), createdAt: String(j.created_at), tab, title, text: mission ? String(mission.request_text ?? "") : legacy.get(String(j.id)) ?? "" });
  }

  const pendingAll: Array<PendingIndexRow & { text: string }> = [];
  for (const m of missions) {
    if (m.job_id) continue;
    const text = String(m.request_text ?? "");
    if ((WAITING_STATUSES as readonly string[]).includes(m.status)) {
      const view = openMissionView({ id: m.id, status: m.status, request_text: m.request_text, created_at: m.created_at, lease_until: m.lease_until }, now);
      if (view) pendingAll.push({ id: view.id, status: view.status, stateAr: view.stateAr, requestText: view.requestText, createdAt: view.createdAt, cancellable: view.cancellable, conversationId: null, text });
      continue;
    }
    if ((RUNNING_STATUSES as readonly string[]).includes(m.status)) {
      rows.push({ type: "mission", id: String(m.id), createdAt: String(m.created_at), tab: "running", title: oneLine(text, 200), endedKind: null, noteAr: RUNNING_NOTE_AR[m.status] ?? "قيد التنفيذ", conversationId: null, text });
      continue;
    }
    if ((ENDED_STATUSES as readonly string[]).includes(m.status)) {
      const endedKind: EndedKind = m.status === "cancelled" ? (isExpiredMission(m) ? "expired" : "cancelled") : m.status === "failed" ? "failed" : "unserved";
      // a stored sentence is shown only when it is customer-safe Arabic; otherwise the fixed sentence of its kind
      const stored = endedKind === "failed" || endedKind === "unserved" ? customerSafeText(m.summary_ar, "") : "";
      rows.push({ type: "mission", id: String(m.id), createdAt: String(m.created_at), tab: "ended", title: oneLine(text, 200), endedKind, noteAr: stored || ENDED_NOTE_AR[endedKind], conversationId: null, text });
    }
  }

  const matches = <T extends { text: string }>(r: T) => matchesSearch(r.text, terms);
  const listRows = rows.filter(matches);
  const pending = pendingAll.filter(matches);
  const counts: Record<RequestTab, number> = {
    all: listRows.length + pending.length,
    running: listRows.filter((r) => r.tab === "running").length,
    done: listRows.filter((r) => r.tab === "done").length,
    ended: listRows.filter((r) => r.tab === "ended").length,
    refunded: listRows.filter((r) => r.tab === "refunded").length,
  };

  const inTab = (input.tab === "all" ? listRows : listRows.filter((r) => r.tab === input.tab)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const page = inTab.slice(offset, offset + limit);
  const shown = input.tab === "all" ? [...pending].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) : [];

  const wanted = new Set<string>([...page.filter((r): r is MissionIndexRow & { text: string } => r.type === "mission").map((r) => r.id), ...shown.map((p) => p.id)]);
  const conversationOf = wanted.size > 0 ? await conversationsOfMissions(client, input.userId) : new Map<string, string>();

  return {
    counts,
    rows: page.map(({ text: _text, ...r }) => (r.type === "mission" ? { ...r, conversationId: conversationOf.get(r.id) ?? null } : r)),
    pending: shown.map(({ text: _text, ...p }) => ({ ...p, conversationId: conversationOf.get(p.id) ?? null })),
    hasMore: offset + limit < inTab.length,
    nextOffset: Math.min(inTab.length, offset + limit),
  };
}
