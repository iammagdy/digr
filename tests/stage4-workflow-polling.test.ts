import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileWorkflowBody } from "../src/components/mission/FileWorkflow";
import { finishedSince, isInFlight, needsPolling, WORKFLOW_POLL_MAX_MS, WORKFLOW_POLL_MS } from "../src/lib/agentMission/stage4/workflowPolling";
import { fetchFileWorkflow } from "../src/lib/agentMission/stage4/fileWorkflowClient";
import type { AddonPhase, WorkflowItemView } from "../src/lib/agentMission/stage4/fileWorkflowLabels";

/** AUDIT D2 and D3: the panel asks again while a request is in flight; a finished request refreshes the versions and the report; a file with no published version draws no promise. */
const item = (phase: AddonPhase, over: Partial<WorkflowItemView> = {}): WorkflowItemView => ({ kind: "edit", version: 1, newVersion: 2, phase, ...over });
const ALL: AddonPhase[] = ["waiting_approval", "approval_unverified", "processing", "delivered", "charged_delivery_pending", "failed_no_charge", "cancelled", "ended_unverified", "delivery_pending"];

describe("which phases are polled", () => {
  it("exactly the ones that change by themselves", () => {
    expect(ALL.filter((p) => isInFlight(item(p)))).toEqual(["approval_unverified", "processing", "charged_delivery_pending", "delivery_pending"]);
  });
  it("a customer decision (waiting for approval) and every final phase are never polled", () => {
    for (const p of ["waiting_approval", "delivered", "failed_no_charge", "cancelled", "ended_unverified"] as AddonPhase[]) expect(needsPolling({ items: [item(p)] })).toBe(false);
    expect(needsPolling(null)).toBe(false);
    expect(needsPolling({ items: [] })).toBe(false);
    expect(needsPolling({ items: [item("delivered"), item("processing", { version: 2 })] })).toBe(true);
  });
  it("the cadence is gentle: 10 seconds, at most an hour", () => { expect(WORKFLOW_POLL_MS).toBe(10_000); expect(WORKFLOW_POLL_MAX_MS).toBe(3_600_000); });
});

describe("a request that stopped being in flight is reported (this is what reloads the versions)", () => {
  it("processing -> delivered, failed, cancelled: reported once", () => {
    for (const next of ["delivered", "failed_no_charge", "cancelled"] as AddonPhase[]) expect(finishedSince({ items: [item("processing")] }, { items: [item(next)] })).toEqual(["edit:1"]);
  });
  it("still in flight, or no previous reading, or a failed reading: nothing is reported", () => {
    expect(finishedSince({ items: [item("processing")] }, { items: [item("processing")] })).toEqual([]);
    expect(finishedSince(null, { items: [item("delivered")] })).toEqual([]);
    expect(finishedSince({ items: [item("processing")] }, null)).toEqual([]);
    expect(finishedSince({ items: [item("waiting_approval")] }, { items: [item("processing")] })).toEqual([]);
  });
  it("a request that disappears from the list counts as finished; another version's request stays", () => {
    expect(finishedSince({ items: [item("processing"), item("processing", { version: 2 })] }, { items: [item("processing", { version: 2 })] })).toEqual(["edit:1"]);
  });
});

describe("a file with no published version draws no promise (D3)", () => {
  const html = (view: any) => renderToStaticMarkup(createElement(FileWorkflowBody, { status: "ready", view }));
  it("no items and hasVersions false: nothing is drawn", () => { expect(html({ items: [], hasVersions: false })).toBe(""); });
  it("no items and hasVersions true or not told: the usual «you have not asked yet» text", () => {
    expect(html({ items: [], hasVersions: true })).toContain("file-workflow-none");
    expect(html({ items: [] })).toContain("file-workflow-none");
  });
  it("items are always shown, whatever hasVersions says", () => { expect(html({ items: [item("processing")], hasVersions: false })).toContain("file-workflow-items"); });
  it("the client passes hasVersions false through and nothing else", async () => {
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body } as any);
    const run = (workflow: unknown) => fetchFileWorkflow({ missionId: "msn_5851abc92a1e6645a9cd", fetchFn: (async () => ok({ success: true, workflow })) as any, headers: async () => ({}) });
    expect(await run({ items: [], hasVersions: false })).toEqual({ state: "ok", view: { items: [], hasVersions: false } });
    expect(await run({ items: [], hasVersions: true })).toEqual({ state: "ok", view: { items: [] } });
    expect(await run({ items: [] })).toEqual({ state: "ok", view: { items: [] } });
  });
});

describe("wiring (source pins; the real browser run proves it end to end)", () => {
  const panel = readFileSync("src/components/mission/FileWorkflow.tsx", "utf8");
  const page = readFileSync("src/app/dashboard/requests/[id]/page.tsx", "utf8");
  it("the panel polls only while in flight, skips a hidden tab, loads silently (no flicker) and announces a finished request", () => {
    expect(panel).toContain("needsPolling(view)");
    expect(panel).toContain("document.hidden");
    expect(panel).toContain("load(() => alive, true)");
    expect(panel).toContain("FILE_DELIVERED_EVENT");
    expect(panel).toContain("clearInterval(timer)");
  });
  it("the page mounts the four dependent surfaces again when something finished", () => {
    expect(page).toContain("FILE_DELIVERED_EVENT");
    for (const c of ["VersionList", "ReviewQuote", "ReviewReport", "EditRequestCard"]) expect(page).toContain(`<${c} key={\`${c}-\${deliveredEpoch}\`}`);
    expect(page).not.toMatch(/<FileWorkflow key=/);
  });
});

describe("AUDIT D5: the edit card offers only kinds that can be completed", () => {
  it("add_column (always «unsupported» on the server) is not selectable; the three real kinds are, in order", async () => {
    const { OFFERED_EDIT_KINDS, EDIT_KINDS_AR } = await import("../src/lib/agentMission/stage4/editRequestLabels");
    expect([...OFFERED_EDIT_KINDS]).toEqual(["rename_column", "set_cells", "add_rows"]);
    expect(OFFERED_EDIT_KINDS.every((k) => k in EDIT_KINDS_AR)).toBe(true);
    expect(readFileSync("src/components/mission/EditRequestCard.tsx", "utf8")).toContain("const KINDS = OFFERED_EDIT_KINDS;");
  });
});

describe("AUDIT D6: a failed request whose release was not confirmed is never shown as «no charge»", () => {
  it("failed with a job and NO recorded settled amount: ended_unverified; with 0 recorded (released): failed_no_charge; no job at all: failed_no_charge", async () => {
    const { addonPhaseOf } = await import("../src/lib/agentMission/stage4/fileWorkflow");
    const { addonRowOf } = await import("./helpers/addonWorld");
    const base = addonRowOf({ kind: "edit", of: "msn_5851abc92a1e6645a9cd" });
    const published = { versions: new Set<number>(), reviews: new Set<number>() };
    const phase = (over: Record<string, unknown>) => addonPhaseOf({ id: base.id, status: "failed", plan: base.plan, ...over } as any, published)?.phase;
    expect(phase({ job_id: "job_x", charged_points: null })).toBe("ended_unverified");
    expect(phase({ job_id: "job_x" })).toBe("ended_unverified");
    expect(phase({ job_id: "job_x", charged_points: 0 })).toBe("failed_no_charge");
    expect(phase({ job_id: null, charged_points: null })).toBe("failed_no_charge");
    expect(phase({ job_id: "job_x", charged_points: 120, error: "charged_not_published" })).toBe("charged_delivery_pending");
    expect(phase({ job_id: "job_x", charged_points: null, error: "charged_not_published" })).toBe("charged_delivery_pending");
  });
});
