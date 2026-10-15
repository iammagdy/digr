import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createAdminClient } from "../src/lib/supabase/server";

async function main() {
  const sb = createAdminClient();
  const jid = "job_quote_a5fb246b5d8095a3413f20fc68a5467c";
  const { data: job } = await sb.from("jobs").select("*").eq("id", jid).single();
  console.log("JOB:", job);
  const { data: events } = await sb
    .from("job_events")
    .select("*")
    .eq("job_id", jid)
    .order("created_at", { ascending: true });
  console.log("EVENTS:", events);
}

main().catch(console.error);
