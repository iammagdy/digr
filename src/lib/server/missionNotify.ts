import { buildMissionNotice, type MissionNoticeFacts, type MissionNoticeKind } from "../agentMission/notices";
import { userWillBeEmailed } from "../agentMission/emailEligibility";
import { missionTitleAr } from "../agentMission/fileNames";
import { openJobHref } from "../requestLinks";
import { conversationOfMissionId } from "./jobConversation";
import { insertJobNotice } from "./jobNotices";
import { sendPlatformEmail, resolveDisplayName } from "./sendPlatformEmail";

/**
 * Sends the in-site notice (a deterministic id: the same notice twice is a no-op) and, for a real customer whose preferences allow it, the e-mail through the existing send-email function
 * (idempotent by key). A guest has no real address and is never e-mailed. Never throws and never touches money: a notice must not fail the path that sends it.
 *
 * The words are specific to THE MISSION (its title, delivered of requested, points charged) and the button opens THAT request's own conversation, with its card and files (`openJobHref`), not a list.
 */
export async function sendMissionNotice(client: any, input: { userId: string; missionId: string; jobId: string | null; kind: MissionNoticeKind; facts: MissionNoticeFacts }, now: () => Date = () => new Date()): Promise<{ inApp: boolean; email: boolean }> {
  const out = { inApp: false, email: false };
  try {
    let title: string | null = null;
    try {
      const { data: mission } = await client.from("missions").select("plan,request_text").eq("id", input.missionId).maybeSingle();
      if (mission) title = missionTitleAr({ plan: mission.plan ?? null, requestText: mission.request_text ?? null });
    } catch { /* the notice says «مهمتك» */ }
    const notice = buildMissionNotice(input.kind, input.facts, title);
    const conversationId = input.kind === "started" ? null : await conversationOfMissionId(client, input.userId, input.missionId);
    // the button opens THIS request: its own conversation with its card and files; without a conversation (an older request) the list opens on that job
    const path = conversationId ? (input.jobId ? openJobHref({ jobId: input.jobId, conversationId }) : `/dashboard/chat?c=${encodeURIComponent(conversationId)}`) : input.jobId ? `${notice.link}?job=${encodeURIComponent(input.jobId)}` : notice.link;
    out.inApp = await insertJobNotice(client, input.userId, { title: notice.title, body: notice.body, link: input.kind === "started" ? notice.link : path, id: `notif_${input.kind}_${input.missionId}` }, now);
    if (!out.inApp || !notice.email) return out;
    const got = await client.auth?.admin?.getUserById?.(input.userId);
    const user = got?.data?.user;
    if (!userWillBeEmailed(user)) return out;
    const site = (process.env.NEXT_PUBLIC_SITE_URL || "https://diger.tech").replace(/\/+$/, "");
    const sent = await sendPlatformEmail("job-update", user.email, {
      Name: resolveDisplayName(user), Subject: notice.email.subject, Preheader: notice.email.preheader, Heading: notice.email.heading, Lead: notice.email.lead, DetailOne: notice.email.detail1, DetailTwo: notice.email.detail2, ButtonLabel: notice.email.buttonLabel,
      JobURL: `${site}${path}`,
    }, `mission-update:${input.kind}:${input.missionId}`);
    out.email = Boolean(sent?.ok);
  } catch {
    // never throws
  }
  return out;
}
