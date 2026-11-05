import { composeLaunchAnnouncement } from "./announcement";
import { NEWS_PAGE_SIZE, type NewsCampaignDeps, type NewsUser, isCampaignMarked } from "./newsCampaign";
import { buildUnsubscribeUrl } from "../server/unsubscribeToken";

/**
 * Production wiring of the campaign runner's dependencies over the Supabase admin client (service role; server only). The admin client and the
 * sender are INJECTED, so the tests drive this with fakes. Nothing here runs by itself: only the admin route (double-locked) calls it.
 *
 * The «already mailed» mark is `app_metadata.campaigns[<campaign>]`: app_metadata is written only with the service role, so a customer cannot
 * clear it (user_metadata, which a customer can edit, is never used for it). Every write MERGES the existing app_metadata (the `role` etc. stay).
 */
type Env = Readonly<Record<string, string | undefined>>;

const plain = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});

async function readUser(admin: any, id: string): Promise<NewsUser | null> {
  const { data, error } = await admin.auth.admin.getUserById(id);
  return error || !data?.user ? null : (data.user as NewsUser);
}

export interface NewsWiringInput {
  admin: any;
  env: Env;
  siteUrl: string;
  /** The server secret that signs unsubscribe links (SUPABASE_SERVICE_ROLE_KEY). */
  signingKey: string;
  send: NewsCampaignDeps["send"];
  now?: () => number;
  log?: NewsCampaignDeps["log"];
  testAccountIds?: ReadonlySet<string>;
  isTestAccount?: NewsCampaignDeps["isTestAccount"];
  suppressed?: ReadonlySet<string>;
  onlyUserIds?: ReadonlySet<string>;
}

export function createNewsCampaignDeps(input: NewsWiringInput): NewsCampaignDeps {
  const { admin } = input;
  return {
    async listUsers(page) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: NEWS_PAGE_SIZE });
      if (error) throw new Error("list_failed");
      return (data?.users ?? []) as NewsUser[];
    },
    getUserById: (id) => readUser(admin, id),
    isSent: (user, campaign) => isCampaignMarked(user, campaign),
    async markSent(userId, campaign, at) {
      try {
        const first = await readUser(admin, userId);
        if (!first || isCampaignMarked(first, campaign)) return false; // someone else holds the mark: send nothing
        // re-read the CURRENT app_metadata immediately before the write and merge only THIS campaign's key: another campaign's mark is never dropped
        const user = await readUser(admin, userId);
        if (!user || isCampaignMarked(user, campaign)) return false;
        const app = plain(user.app_metadata);
        const { error } = await admin.auth.admin.updateUserById(userId, { app_metadata: { ...app, campaigns: { ...plain(app.campaigns), [campaign]: at } } });
        return !error;
      } catch {
        return false;
      }
    },
    async unmarkSent(userId, campaign) {
      const user = await readUser(admin, userId);
      if (!user) return;
      const app = plain(user.app_metadata);
      const { [campaign]: _removed, ...rest } = plain(app.campaigns);
      await admin.auth.admin.updateUserById(userId, { app_metadata: { ...app, campaigns: rest } });
    },
    // the footer link of the news template reads {{ .UnsubscribeURL }}: it is the SAME per-recipient URL as the List-Unsubscribe header
    send: (i) => input.send({ ...i, vars: { ...i.vars, UnsubscribeURL: i.unsubscribeUrl } }),
    compose: (name) => composeLaunchAnnouncement(input.env, name) as unknown as Record<string, string> | null,
    unsubscribeUrl: (userId) => buildUnsubscribeUrl(input.siteUrl, userId, input.signingKey),
    now: input.now ?? Date.now,
    log: input.log ?? ((event, fields) => console.log(`[launch-email:${event}]`, JSON.stringify(fields))),
    testAccountIds: input.testAccountIds,
    isTestAccount: input.isTestAccount,
    suppressed: input.suppressed,
    onlyUserIds: input.onlyUserIds,
  };
}
