import { buildMissionNotice, type MissionNoticeFacts, type MissionNoticeKind } from "../agentMission/notices";
import { userWillBeEmailed } from "../agentMission/emailEligibility";
import { insertJobNotice } from "./jobNotices";
import { sendPlatformEmail, resolveDisplayName } from "./sendPlatformEmail";

/**
 * Sends the in-site notice (a deterministic id: the same notice twice is a no-op) and, for a real customer whose preferences allow it, the e-mail through the existing send-email function
 * (idempotent by key). A guest has no real address and is never e-mailed. Never throws and never touches money: a notice must not fail the path that sends it.
 */
export async function sendMissionNotice(client: any, input: { userId: string; missionId: string; jobId: string | null; kind: MissionNoticeKind; facts: MissionNoticeFacts }, now: () => Date = () => new Date()): Promise<{ inApp: boolean; email: boolean }> {
  const out = { inApp: false, email: false };
  try {
    const notice = buildMissionNotice(input.kind, input.facts);
    out.inApp = await insertJobNotice(client, input.userId, { title: notice.title, body: notice.body, link: notice.link, id: `notif_${input.kind}_${input.missionId}` }, now);
    if (!out.inApp || !notice.email) return out;
    const got = await client.auth?.admin?.getUserById?.(input.userId);
    const user = got?.data?.user;
    if (!userWillBeEmailed(user)) return out;
    const sent = await sendPlatformEmail("job-update", user.email, {
      Name: resolveDisplayName(user), Subject: notice.email.subject, Heading: notice.email.heading, Lead: notice.email.lead, DetailOne: notice.email.detail1, DetailTwo: notice.email.detail2, ButtonLabel: notice.email.buttonLabel,
      JobURL: `${(process.env.NEXT_PUBLIC_SITE_URL || "https://diger.tech").replace(/\/+$/, "")}/dashboard/requests${input.jobId ? `?job=${encodeURIComponent(input.jobId)}` : ""}`,
    }, `mission-update:${input.kind}:${input.missionId}`);
    out.email = Boolean(sent?.ok);
  } catch {
    // never throws
  }
  return out;
}
