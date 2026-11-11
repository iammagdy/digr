import { AGENT_BUCKET, MISSION_EVENTS_TABLE, MISSION_TABLE } from "../constants";
import { ADDON_MARKER_SELECT, isAddonRow } from "./addonMarkerRule";
import { buildAsk } from "../foundation/ask";
import { readSemanticNormalizationFlagFromClient } from "../semantic/flag";
import { ASK_EDIT_REJECTION_AR, applyAskEdit, askCardView, editScopeOf, parseAskEdit, type AskCardView, type AskEditRejection, type EditScope } from "./askCard";
import type { Ask } from "../foundation/ask";
import { ASK_EDITS_FOLDER, askEditPath, askEditsOf, nextAskEditIndex } from "./askEditStore";
import { STAGE2_TEST_MARKER_FOLDER, STAGE2_TEST_MARKER_NAME, stage2FlagMode, type Stage2Flag } from "./flags";

/**
 * STAGE 2 S3 (docs/STAGE-2.md): THE CUSTOMER EDITS THE «فهمنا طلبك» CARD. Only for the customer's own mission in status `plan_ready` (a plan is shown and NOT approved: nothing is held yet).
 * The edit is checked by code (a refusal is a reason code with its fixed Arabic sentence), kept as a create-only object `ask_edits/eNNNN.json` in the mission's folder, and the mission goes
 * back to planning exactly like an answer to a question does today (`answerForCustomer`: status `queued`, the worker re-plans, now with the edits). The new price is the new plan's, by code.
 *
 * MONEY: this touches NO money line. It never creates, changes or releases a hold or a reservation, never calls a money function and never writes the ledger: it writes the edit object, the
 * mission's status fields (status, worker, lease, question, time) and one event. A mission in any other status (approved, running, ...) is refused.
 */
import { ASK_EDIT_RECEIVED_AR } from "./cardText";
export { ASK_EDIT_NEW_READ_AR, ASK_EDIT_RECEIVED_AR } from "./cardText";
const NOT_FOUND_AR = "المهمة غير موجودة.";
const NOT_NOW_AR = "لا يمكن تعديل الطلب الآن؛ التعديل متاح قبل اعتماد الخطة فقط.";
const SAVE_FAILED_AR = "تعذّر حفظ تعديلك. حاول مرة أخرى؛ لم يُخصم شيء.";

export type AskEditActionResult =
  | { ok: true; status: "queued"; scope: EditScope }
  | { ok: false; status: number; error: string; reason?: AskEditRejection };

/**
 * Is a Stage 2 flag on for this mission's customer? «on»: yes; «test»: only when the worker marked the mission's account as a test account (`stage2/test_account.json`, flags.ts); unset or
 * anything else: no, and nothing is read. The caller still checks that the viewer owns the mission.
 */
export async function stage2FlagForMission(client: any, flag: Stage2Flag, missionId: string, env?: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  const mode = stage2FlagMode(flag, env);
  if (mode === "off") return false;
  if (mode === "on") return true;
  try {
    const listed = await client.storage.from(AGENT_BUCKET).list(`${missionId}/${STAGE2_TEST_MARKER_FOLDER}`, { limit: 10 });
    return !listed?.error && ((listed?.data ?? []) as Array<{ name: string }>).some((o) => o.name === STAGE2_TEST_MARKER_NAME);
  } catch {
    return false;
  }
}

export async function askEditForCustomer(client: any, input: { id: string; userId: string; edit: unknown; nowMs?: number }): Promise<AskEditActionResult> {
  const { data: mission } = await client.from(MISSION_TABLE).select(`id,user_id,status,request_text,answer_text,created_at,${ADDON_MARKER_SELECT}`).eq("id", input.id).maybeSingle();
  // an add-on row (a review or edit of a delivered file) is not a research mission: «not found», before anything is read, kept or written (Money PR 7e)
  if (!mission || mission.user_id !== input.userId || isAddonRow(mission)) return { ok: false, status: 404, error: NOT_FOUND_AR };
  if (mission.status !== "plan_ready") return { ok: false, status: 409, error: NOT_NOW_AR };
  const parsed = parseAskEdit(input.edit);
  if (!parsed.ok) return { ok: false, status: 400, error: ASK_EDIT_REJECTION_AR[parsed.reason], reason: parsed.reason };
  const nowMs = input.nowMs ?? Date.now();
  // the Ask the card shows: the request, then the edits already kept (in order), then this one; a refused edit is answered with its code and nothing is written
  const bucket = client.storage.from(AGENT_BUCKET);
  const kept = await keptEdits(client, input.id);
  if (!kept) return { ok: false, status: 500, error: SAVE_FAILED_AR };
  const names = kept.names;
  const ask = askOfMission(mission, kept.edits, nowMs, await readSemanticNormalizationFlagFromClient(client, mission.user_id));
  const applied = applyAskEdit(ask, parsed.edit, { nowMs });
  if (!applied.ok) return { ok: false, status: 400, error: ASK_EDIT_REJECTION_AR[applied.reason], reason: applied.reason };
  // create-only: a second edit racing for the same name is refused by the storage (never overwritten)
  const path = `${input.id}/${askEditPath(nextAskEditIndex(names))}`;
  const up = await bucket.upload(path, JSON.stringify(parsed.edit), { contentType: "application/json", upsert: false });
  if (up?.error) return { ok: false, status: up.error.statusCode === "409" || /exists|duplicate/i.test(String(up.error.message ?? "")) ? 409 : 500, error: SAVE_FAILED_AR };
  // back to planning, as an answer does (customerActions `answerForCustomer`): only from `plan_ready`, so an approval that happened in the meantime is never undone
  const upd = await client.from(MISSION_TABLE).update({ status: "queued", question_ar: null, worker_id: null, lease_until: null, updated_at: new Date(nowMs).toISOString() }).eq("id", input.id).eq("status", "plan_ready").select("id");
  if (upd.error) return { ok: false, status: 500, error: SAVE_FAILED_AR };
  if (Array.isArray(upd.data) && upd.data.length === 0) return { ok: false, status: 409, error: NOT_NOW_AR };
  await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.id, kind: "answer", message_ar: ASK_EDIT_RECEIVED_AR, counts: {} });
  return { ok: true, status: "queued", scope: editScopeOf(parsed.edit, ask) };
}

/** The edits already kept for a mission (names and edits, in order), or null when the folder cannot be listed. */
async function keptEdits(client: any, missionId: string): Promise<{ names: string[]; edits: ReturnType<typeof askEditsOf> } | null> {
  const bucket = client.storage.from(AGENT_BUCKET);
  const listed = await bucket.list(`${missionId}/${ASK_EDITS_FOLDER}`, { limit: 1000, sortBy: { column: "name", order: "asc" } });
  if (listed?.error) return null;
  const names: string[] = ((listed?.data ?? []) as Array<{ name: string }>).map((o) => o.name);
  const edits = askEditsOf(await Promise.all(names.map(async (name) => {
    const got = await bucket.download(`${missionId}/${ASK_EDITS_FOLDER}/${name}`);
    return { name, body: got?.error || !got?.data ? null : await got.data.text() };
  })));
  return { names, edits };
}

/** The Ask of a mission as the card shows it: the request and its answer read by code, then every kept edit in order (a refused one is skipped). */
function askOfMission(mission: { request_text?: unknown; answer_text?: unknown; created_at?: unknown }, edits: ReturnType<typeof askEditsOf>, nowMs: number, semantic = false): Ask {
  const createdAt = Date.parse(String(mission.created_at ?? ""));
  let ask = buildAsk(mission.request_text, mission.answer_text, Number.isFinite(createdAt) ? createdAt : nowMs, {}, { semantic });
  for (const e of edits) { const r = applyAskEdit(ask, e, { nowMs }); if (r.ok) ask = r.ask; }
  return ask;
}

/**
 * STAGE 2 S4: the «فهمنا طلبك» card of the customer's own mission while its plan waits for approval (`plan_ready`), or null (another status, another customer, the folder unreadable).
 * Read only. The route calls it only when DIGER_STAGE2_ASK_CARD is on for the viewer.
 */
export async function askCardForCustomer(client: any, input: { id: string; userId: string; nowMs?: number }): Promise<AskCardView | null> {
  const { data: mission } = await client.from(MISSION_TABLE).select(`id,user_id,status,request_text,answer_text,created_at,${ADDON_MARKER_SELECT}`).eq("id", input.id).maybeSingle();
  if (!mission || mission.user_id !== input.userId || mission.status !== "plan_ready" || isAddonRow(mission)) return null;
  const kept = await keptEdits(client, input.id);
  if (!kept) return null;
  const ask = askOfMission(mission, kept.edits, input.nowMs ?? Date.now(), await readSemanticNormalizationFlagFromClient(client, mission.user_id));
  return ask.platform ? askCardView(ask) : null;
}
