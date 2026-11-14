/**
 * CONSOLIDATED MISSION: ONE READER FOR A SERVER-CONTROLLED SWITCH THAT CAN BE ON FOR EVERYONE OR FOR NAMED TEST ACCOUNTS ONLY.
 *
 * The value lives in `agent_settings` (service role only: no policy and no grant for anon or authenticated, docs/proposals/agent-worker/01_agent_tables.sql), the place the redesign flags already live. It is compared with the account's USER ID as the
 * server already knows it: the verified sign-in token on the site, the mission row's `user_id` in the worker. The same value and the same user id give the same answer on both sides, so the chat, the «فهمنا طلبك» card and the worker can never disagree.
 * Nothing the customer sends (a header, a body field, a query, user_metadata, an e-mail address) is ever read.
 *
 *   - exactly the boolean `true` or the string `"on"`: ON for every account;
 *   - an object `{ "user_ids": ["<uuid>", ...] }`: ON only for those exact accounts (lower-cased UUIDs; an entry that is not a UUID is ignored; an empty or malformed list authorizes nobody);
 *   - anything else (missing, null, `false`, `"off"`, `"test"`, a number, a string with spaces, an unreadable value): OFF.
 * Pure; never throws.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function scopedFlagOn(value: unknown, userId?: string | null, nowMs: number = Date.now()): boolean {
  try {
    if (value === true || value === "on") return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    // ACCEPTANCE CAMPAIGNS (acceptance/campaign.ts): a scoped value may carry `expires_at` (ISO time). From that moment it is OFF for everyone, whether or not anybody restores it: a test account's
    // switch can never be left on by a forgotten restore. A value without the field is read exactly as before; an unreadable `expires_at` is OFF.
    const expires = (value as { expires_at?: unknown }).expires_at;
    if (expires !== undefined) {
      const at = typeof expires === "string" ? Date.parse(expires) : Number.NaN;
      if (!Number.isFinite(at) || !(nowMs < at)) return false;
    }
    const list = (value as { user_ids?: unknown }).user_ids;
    if (!Array.isArray(list) || typeof userId !== "string") return false;
    const id = userId.trim().toLowerCase();
    if (!UUID.test(id)) return false;
    return list.some((entry) => typeof entry === "string" && UUID.test(entry.trim().toLowerCase()) && entry.trim().toLowerCase() === id);
  } catch {
    return false;
  }
}

/** The raw value of one key of `agent_settings`, read with the server's service-role client. Any failure or a missing row is `undefined` (OFF). */
export async function readSettingValue(client: any, key: string, table = "agent_settings"): Promise<unknown> {
  try {
    const { data, error } = await client.from(table).select("value").eq("key", key).maybeSingle();
    if (error || !data) return undefined;
    return (data as { value?: unknown }).value;
  } catch {
    return undefined;
  }
}
