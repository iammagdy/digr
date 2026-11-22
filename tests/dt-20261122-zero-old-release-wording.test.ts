import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OVERVIEW_PAYMENT_AR } from "../src/components/landing/Overview";
import { REQUEST_STATUS_LABEL_AR, deliveredChargedLineAr } from "../src/lib/jobs/requestStatus";
import { FAILURE_STATE_AR } from "../src/lib/publicCopy";
import { WORKER_START_FINAL_REASON_AR } from "../src/lib/server/workerStartFailure";
import { normalizeReleaseWording } from "../src/lib/releaseWording";

/**
 * Task DT-20261122-release-wording (Megz D-0187):
 * Zero customer-facing occurrences of «حجز مؤقت مُحرَّر» across all customer text sources.
 * A returned hold is «رجع لمحفظتك».
 */
const SCANNED_DIRS = [
  "src/components",
  "src/app/dashboard",
  "src/app/pricing",
  "src/app/api/worker/chunk",
  "src/lib",
  "src/functions",
  "agent/src",
];

function walk(dir: string, out: string[] = []): string[] {
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(path);
    }
  } catch {
    // skip non-existent
  }
  return out;
}

describe("DT-20261122: zero «حجز مؤقت مُحرَّر» in customer text sources", () => {
  it("verifies scanned dirs have zero customer-facing «حجز مؤقت مُحرَّر»", () => {
    const BANNED = "حجز مؤقت مُحرَّر";
    // Allowed: admin routes, legal text, and normalizers that accept legacy text
    const allowed = [
      /lib\/legalText\.ts$/,
      /admin\//,
      /app\/admin\//,
      /lib\/walletText\.ts$/,
      /lib\/releaseWording\.ts$/,
    ];

    const hits: string[] = [];

    for (const dir of SCANNED_DIRS) {
      for (const file of walk(dir)) {
        if (allowed.some((pattern) => pattern.test(file))) continue;
        const content = readFileSync(file, "utf8");
        content.split("\n").forEach((line, index) => {
          // Ignore comments
          if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
          // Ignore legacy input checks (e.g. textAr.includes("حجز مؤقت مُحرَّر"))
          if (line.includes(`includes("${BANNED}")`)) return;
          if (line.includes(BANNED)) {
            hits.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }

    expect(hits).toEqual([]);
  });

  it("status chip for an unserved request says «رجع لمحفظتك»", () => {
    expect(REQUEST_STATUS_LABEL_AR.refunded).toBe("تعذر التنفيذ · رجع لمحفظتك");
    expect(REQUEST_STATUS_LABEL_AR.refunded).toContain("رجع لمحفظتك");
    expect(REQUEST_STATUS_LABEL_AR.refunded).not.toContain("حجز مؤقت مُحرَّر");
  });

  it("landing overview, failure state and worker start reason say «رجع لمحفظتك»", () => {
    expect(OVERVIEW_PAYMENT_AR).toContain("رجع لمحفظتك");
    expect(OVERVIEW_PAYMENT_AR).not.toContain("حجز مؤقت مُحرَّر");
    expect(FAILURE_STATE_AR).toContain("رجع لمحفظتك");
    expect(FAILURE_STATE_AR).not.toContain("حجز مؤقت مُحرَّر");
    expect(WORKER_START_FINAL_REASON_AR).toContain("رجع لمحفظتك");
    expect(WORKER_START_FINAL_REASON_AR).not.toContain("حجز مؤقت مُحرَّر");
  });

  it("normalizeReleaseWording converts legacy text TO «رجع لمحفظتك»", () => {
    expect(normalizeReleaseWording("توقف طلبك وأعدنا نقاطك")).toContain("رجع لمحفظتك");
    expect(normalizeReleaseWording("فأعدنا نقاطك المحجوزة كاملة لرصيدك دون أي خصم")).toBe("رجع لمحفظتك كاملًا دون أي خصم");
    expect(normalizeReleaseWording("حجز مؤقت مُحرَّر كاملًا")).toBe("رجع لمحفظتك كاملًا");
    expect(normalizeReleaseWording("حُرّر حجزك المؤقت")).toBe("رجع لمحفظتك");
    expect(normalizeReleaseWording("حُرّر حجز مؤقت بقيمة ٢٠ نقطة")).toBe("رجع لمحفظتك بقيمة ٢٠ نقطة");
  });

  it("contacts mission card grammar: «في عنصر واحد» after preposition", () => {
    const line = deliveredChargedLineAr({ delivered: 6, charged: 5, concise: true });
    expect(line).toBe("استلمت ٦، ودُفع ثمن ٥ لعدم توفر بيانات الاتصال في عنصر واحد.");
    expect(line).not.toContain("عنصرًا واحدًا");
  });
});
