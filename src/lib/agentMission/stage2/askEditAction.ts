import { AGENT_BUCKET, MISSION_EVENTS_TABLE, MISSION_TABLE } from "../constants";
import { buildAsk } from "../foundation/ask";
import { isTestAccount } from "../../server/testAccounts";
import { ASK_EDIT_REJECTION_AR, applyAskEdit, editScopeOf, parseAskEdit, type AskEditRejection, type EditScope } from "./askCard";
import { ASK_EDITS_FOLDER, askEditPath, askEditsOf, nextAskEditIndex } from "./askEditStore";
import { stage2FlagMode, type Stage2Flag } from "./flags";

/**
 * STAGE 2 S3 (docs/STAGE-2.md): THE CUSTOMER EDITS THE «فهمنا طلبك» CARD. Only for the customer's own mission in status `plan_ready` (a plan is shown and NOT approved: nothing is held yet).
 * The edit is checked by code (a refusal is a reason code with its fixed Arabic sentence), kept as a create-only object `ask_edits/eNNNN.json` in the mission's folder, and the mission goes
 * back to planning exactly like an answer to a question does today (`answerForCustomer`: status `queued`, the worker re-plans, now with the edits). The new price is the new plan's, by code.
 *
 * MONEY: this touches NO money line. It never creates, changes or releases a hold or a reservation, never calls a money function and never writes the ledger: it writes the edit object, the
 * mission's status fields (status, worker, lease, question, time) and one event. A mission in any other status (approved, running, ...) is refused.
 */
export const ASK_EDIT_RECEIVED_AR = "وصل تعديلك، ونجهّز الخطة من جديد.";
export const ASK_EDIT_NEW_READ_AR = "سنقرأ النتائج من جديد بعد هذا التعديل.";
const NOT_FOUND_AR = "المهمة غير موجودة.";
const NOT_NOW_AR = "لا يمكن تعديل الطلب الآن؛ التعديل متاح قبل اعتماد الخطة فقط.";
const SAVE_FAILED_AR = "تعذّر حفظ تعديلك. حاول مرة أخرى؛ لم يُخصم شيء.";

export type AskEditActionResult =
  | { ok: true; status: "queued"; scope: EditScope }
  | { ok: false; status: number; error: string; reason?: AskEditRejection };

/**
 * Is a Stage 2 flag on for this viewer? «on»: yes; «test»: only for a test account (its e-mail read with the admin client); unset or anything else: no, and nothing is read.
 */
export async function stage2FlagForViewer(client: any, flag: Stage2Flag, userId: string, env?: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  const mode = stage2FlagMode(flag, env);
  if (mode === "off") return false;
  if (mode === "on") return true;
  try {
    const user = (await client.auth?.admin?.getUserById?.(userId))?.data?.user;
    return isTestAccount({ id: userId, email: user?.email ?? null });
  } catch {
    return false;
  }
}

export async function askEditForCustomer(client: any, input: { id: string; userId: string; edit: unknown; nowMs?: number }): Promise<AskEditActionResult> {
  const { data: mission } = await client.from(MISSION_TABLE).select("id,user_id,status,request_text,answer_text,created_at").eq("id", input.id).maybeSingle();
  if (!mission || mission.user_id !== input.userId) return { ok: false, status: 404, error: NOT_FOUND_AR };
  if (mission.status !== "plan_ready") return { ok: false, status: 409, error: NOT_NOW_AR };
  const parsed = parseAskEdit(input.edit);
  if (!parsed.ok) return { ok: false, status: 400, error: ASK_EDIT_REJECTION_AR[parsed.reason], reason: parsed.reason };
  const nowMs = input.nowMs ?? Date.now();
  // the Ask the card shows: the request, then the edits already kept (in order), then this one; a refused edit is answered with its code and nothing is written
  const bucket = client.storage.from(AGENT_BUCKET);
  const listed = await bucket.list(`${input.id}/${ASK_EDITS_FOLDER}`, { limit: 1000, sortBy: { column: "name", order: "asc" } });
  if (listed?.error) return { ok: false, status: 500, error: SAVE_FAILED_AR };
  const names: string[] = ((listed?.data ?? []) as Array<{ name: string }>).map((o) => o.name);
  const earlier = askEditsOf(await Promise.all(names.map(async (name) => {
    const got = await bucket.download(`${input.id}/${ASK_EDITS_FOLDER}/${name}`);
    return { name, body: got?.error || !got?.data ? null : await got.data.text() };
  })));
  const createdAt = Date.parse(String(mission.created_at ?? ""));
  let ask = buildAsk(mission.request_text, mission.answer_text, Number.isFinite(createdAt) ? createdAt : nowMs);
  for (const e of earlier) { const r = applyAskEdit(ask, e, { nowMs }); if (r.ok) ask = r.ask; }
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
