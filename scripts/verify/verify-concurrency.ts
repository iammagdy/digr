/**
 * Live Verification Script: 20 Parallel Concurrency Requests
 * Usage: tsx scripts/verify/verify-concurrency.ts
 * Strictly reads keys from environment variables. Zero hardcoded secrets.
 */
import https from "https";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://pfinlfaqwnytesedchik.supabase.co";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

if (!ANON_KEY) {
  console.error("ERROR: NEXT_PUBLIC_SUPABASE_ANON_KEY must be provided via environment variable.");
  process.exit(1);
}

function callReserveRpc(jobId: string, amount: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      p_user_id: TEST_USER_ID,
      p_job_id: jobId,
      p_amount: amount,
      p_note: "Parallel concurrency verification",
    });

    const url = new URL("/rest/v1/rpc/reserve_credits_atomic", SUPABASE_URL);

    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: ANON_KEY,
          Authorization: `Bearer ${ANON_KEY}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, raw: data });
          }
        });
      }
    );

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log("=== Launching 20 Real Parallel HTTP Requests to PostgREST RPC ===");

  const sameJobCalls = Array.from({ length: 10 }).map(() =>
    callReserveRpc("verify_parallel_same", 25)
  );

  const diffJobCalls = Array.from({ length: 10 }).map((_, idx) =>
    callReserveRpc(`verify_parallel_diff_${idx + 1}`, 15)
  );

  const startTime = Date.now();
  const results = await Promise.all([...sameJobCalls, ...diffJobCalls]);
  const durationMs = Date.now() - startTime;

  console.log(`Executed 20 parallel calls in ${durationMs}ms`);

  const sameJobResults = results.slice(0, 10);
  const diffJobResults = results.slice(10, 20);

  const sameJobSuccess = sameJobResults.filter(
    (r) => r.body && r.body.success && !r.body.already_reserved
  );
  const sameJobAlreadyReserved = sameJobResults.filter(
    (r) => r.body && r.body.already_reserved
  );

  console.log({
    totalCalls: 20,
    durationMs,
    sameJobSuccessCount: sameJobSuccess.length,
    sameJobAlreadyReservedCount: sameJobAlreadyReserved.length,
    diffJobResultsCount: diffJobResults.length,
  });
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
