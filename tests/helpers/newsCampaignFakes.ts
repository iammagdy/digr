import type { NewsCampaignDeps, NewsUser } from "../../src/lib/launch/newsCampaign";

/** FAKE world for the launch-announcement runner: an in-memory user list, an event log, a scripted sender. No network, no real account, no real address. */
export const confirmedAt = "2026-10-01T00:00:00Z";
export const optedIn = (id: string, extra: Partial<NewsUser> = {}): NewsUser => ({
  id,
  email: `${id}@example.test`,
  email_confirmed_at: confirmedAt,
  user_metadata: { full_name: `مستخدم ${id}`, prefs: { notif: { news: true } } },
  app_metadata: {},
  ...extra,
});

export interface World {
  users: NewsUser[];
  events: string[];
  logs: Array<{ event: string; fields: Record<string, string | number> }>;
  sends: Array<{ userId: string; to: string; vars: Record<string, string>; idempotencyKey: string; unsubscribeUrl: string }>;
  /** scripted answers of the sender, consumed in order; then `ok`. */
  script: Array<{ ok: boolean; reason?: string }>;
  /** called after the listing and before each re-read: lets a test change the world between listing and sending */
  beforeReread?: (id: string) => void;
}

export function makeWorld(users: NewsUser[], script: World["script"] = []): World {
  return { users: structuredClone(users), events: [], logs: [], sends: [], script: [...script] };
}

export function makeDeps(world: World, over: Partial<NewsCampaignDeps> = {}, pageSize = 2): NewsCampaignDeps {
  const find = (id: string) => world.users.find((u) => u.id === id);
  return {
    async listUsers(page) {
      world.events.push(`list:${page}`);
      // the listing returns SNAPSHOTS taken now: later changes of the world are not visible in them
      return structuredClone(world.users.slice((page - 1) * pageSize, page * pageSize));
    },
    async getUserById(id) {
      world.beforeReread?.(id);
      world.events.push(`reread:${id}`);
      const u = find(id);
      return u ? structuredClone(u) : null;
    },
    isSent: (user, campaign) => Boolean(user.app_metadata?.campaigns?.[campaign]),
    async markSent(userId, campaign, at) {
      world.events.push(`claim:${userId}`);
      const u = find(userId)!;
      u.app_metadata = { ...(u.app_metadata ?? {}), campaigns: { ...((u.app_metadata as any)?.campaigns ?? {}), [campaign]: at } };
      return true;
    },
    async unmarkSent(userId, campaign) {
      world.events.push(`unclaim:${userId}`);
      const u = find(userId)!;
      const { [campaign]: _gone, ...rest } = ((u.app_metadata as any)?.campaigns ?? {}) as Record<string, string>;
      u.app_metadata = { ...(u.app_metadata ?? {}), campaigns: rest };
    },
    async send(input) {
      world.events.push(`send:${input.userId}`);
      world.sends.push(input);
      return world.script.shift() ?? { ok: true };
    },
    compose: (name) => ({ Name: name, Subject: "جديد في ديجر", Heading: "جديد في ديجر", Lead: "أضفنا", Item1: "• جدول", Item2: "", Item3: "", Item4: "", Item5: "", Item6: "", ButtonLabel: "افتح لوحتك" }),
    unsubscribeUrl: (id) => `https://diger.test/api/email/unsubscribe?t=tok-${id}`,
    now: () => Date.parse("2026-11-10T09:00:00Z"),
    log: (event, fields) => { world.logs.push({ event, fields }); },
    ...over,
  };
}
