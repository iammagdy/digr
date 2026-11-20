import { handleOfficeFeedRequest } from "./handler.ts";

if (import.meta.main) {
  Deno.serve((req: Request) =>
    handleOfficeFeedRequest(req, {
      feedToken: Deno.env.get("OFFICE_FEED_TOKEN") ?? "",
      supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
      serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    }),
  );
}
