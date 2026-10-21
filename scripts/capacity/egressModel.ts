/**
 * Egress model for the conference (bytes that leave the database, auth and storage services, including the server-side reads of the
 * API routes). Every number is an assumption written down here, not a measurement: change one and `tests/egress-model.test.ts` and
 * `docs/SUPABASE_FREE_PLAN.md` show what it does to the 5 GB allowance. The per-turn query counts come from the offline harness.
 */
export interface EgressAssumptions {
  sessionMinutes: number;
  dashboardLoadKb: number;
  notificationCheckKb: number;
  notificationEverySeconds: number;
  badgeCountKb: number;
  badgeEverySeconds: number;
  chatTurns: number;
  chatTurnKb: number;
  missionFollowMinutes: number;
  missionPollEverySeconds: number;
  missionPollKb: number;
  resultsViewKb: number;
  downloadKb: number;
}

export const DEFAULT_EGRESS_ASSUMPTIONS: EgressAssumptions = {
  sessionMinutes: 90,
  dashboardLoadKb: 18,
  notificationCheckKb: 0.6,
  notificationEverySeconds: 75,
  badgeCountKb: 0.5,
  badgeEverySeconds: 30,
  chatTurns: 6,
  chatTurnKb: 50,
  missionFollowMinutes: 20,
  missionPollEverySeconds: 5,
  missionPollKb: 5,
  resultsViewKb: 500,
  downloadKb: 300,
};

export interface EgressScenario { visitors: number; missionShare: number }

const MB = 1024;
const GB = 1024 * 1024;

export function chatOnlyKbPerVisitor(a: EgressAssumptions = DEFAULT_EGRESS_ASSUMPTIONS): number {
  const seconds = a.sessionMinutes * 60;
  return a.dashboardLoadKb
    + (seconds / a.notificationEverySeconds) * a.notificationCheckKb
    + (seconds / a.badgeEverySeconds) * a.badgeCountKb
    + a.chatTurns * a.chatTurnKb;
}

export function missionKbPerVisitor(a: EgressAssumptions = DEFAULT_EGRESS_ASSUMPTIONS): number {
  return ((a.missionFollowMinutes * 60) / a.missionPollEverySeconds) * a.missionPollKb + a.resultsViewKb + a.downloadKb;
}

export function egressGb(s: EgressScenario, a: EgressAssumptions = DEFAULT_EGRESS_ASSUMPTIONS): number {
  return (s.visitors * (chatOnlyKbPerVisitor(a) + s.missionShare * missionKbPerVisitor(a))) / GB;
}

export const EGRESS_SCENARIOS: Array<{ id: string; titleAr: string; scenario: EgressScenario }> = [
  { id: "chat_only", titleAr: "محادثة فقط", scenario: { visitors: 500, missionShare: 0 } },
  { id: "quarter_missions", titleAr: "٢٥٪ يبدؤون مهمة وينزّلون ملفًا", scenario: { visitors: 500, missionShare: 0.25 } },
  { id: "all_missions", titleAr: "الجميع يبدأ مهمة وينزّل ملفًا", scenario: { visitors: 500, missionShare: 1 } },
];

export const EGRESS_ALLOWANCE_GB = 5;
export { MB };
