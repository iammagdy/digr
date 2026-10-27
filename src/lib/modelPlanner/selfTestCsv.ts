/** The row of the planner self-test table and its CSV export. Pure (no server imports): the admin page imports it too. */
export interface SelfTestRow {
  id: string;
  request: string;
  expected: string;
  outcome: "plan" | "question" | "refusal" | "restricted" | "purpose" | "error";
  /** What the customer would read. */
  customerText: string;
  understood: string;
  endpoints: string[];
  alternativesTried: Array<{ endpoint: string; outcome: string; httpStatus: number; ms: number; costUsd: number; detail: string }>;
  params: Array<{ step: number; name: string; value: string; source: string; quote: string }>;
  window: string;
  sampleRows: number;
  unitPricePoints: number | null;
  holdPoints: number | null;
  turns: number;
  stopReasons: string[];
  tokensIn: number;
  tokensOut: number;
  modelUsd: number;
  providerUsd: number;
  pass: boolean;
  reason: string;
  endReason: string;
  trace: string[];
}

/** The table as CSV (admin download): one line per request, quoted. */
export function selfTestCsv(rows: ReadonlyArray<SelfTestRow>): string {
  const head = ["id", "request", "expected", "outcome", "pass", "reason", "understood", "endpoints", "alternatives_tried", "params", "window", "sample_rows", "unit_points", "hold_points", "turns", "stop_reasons", "tokens_in", "tokens_out", "model_usd", "provider_usd", "end_reason"];
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((r) => [r.id, r.request, r.expected, r.outcome, r.pass ? "PASS" : "FAIL", r.reason, r.understood, r.endpoints.join(" > "), r.alternativesTried.map((a) => `${a.endpoint}=${a.outcome}${a.httpStatus ? `/${a.httpStatus}` : ""}`).join("; "), r.params.map((p) => `${p.name}=${p.value} (${p.source})`).join("; "), r.window, r.sampleRows, r.unitPricePoints ?? "", r.holdPoints ?? "", r.turns, r.stopReasons.join(","), r.tokensIn, r.tokensOut, r.modelUsd.toFixed(6), r.providerUsd.toFixed(6), r.endReason].map(q).join(","));
  return `﻿${[head.map(q).join(","), ...lines].join("\n")}\n`;
}
