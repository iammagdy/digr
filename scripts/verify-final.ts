import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createAdminClient } from "../src/lib/supabase/server";

async function main() {
  const sb = createAdminClient();
  const testUserId = "47693c59-89f1-405d-bec1-e72271517870";
  const jobIds = [
    "job_quote_49ef8293c78b15d8e1d60afc85922f2a", // 5 companies
    "job_quote_ad8d35ecc7e1bdbb57842c47ec44bb1f", // 20 companies
    "job_quote_7d10a258ad5ac1e586f0bd5cc4c1a4a0", // TikTok profile
  ];

  for (const jid of jobIds) {
    const { data: job } = await sb.from("jobs").select("*").eq("id", jid).maybeSingle();
    const { data: ledger } = await sb.from("credit_ledger").select("*").eq("job_id", jid).order("created_at", { ascending: true });
    console.log("====================================");
    console.log("JOB:", jid);
    console.log("Status:", job?.status, "| Delivered:", job?.delivered_units, "| Reserved:", job?.reserved_credits, "| Charged:", job?.charged_credits, "| Error:", job?.error_message);
    console.log("Ledger rows:");
    for (const l of ledger || []) {
      console.log(l);
    }
  }

  const { data: allLedger } = await sb.from("credit_ledger").select("delta, type").eq("user_id", testUserId);
  const totalBalance = (allLedger || []).reduce((acc, row) => acc + (row.delta || 0), 0);
  console.log("====================================");
  console.log("TOTAL LEDGER DELTA SUM (BALANCE):", totalBalance);
  console.log("====================================");
}

main().catch(console.error);
