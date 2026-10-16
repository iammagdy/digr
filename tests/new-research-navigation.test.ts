import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { startNewResearch } from "../src/lib/newResearchNavigation";

describe("new research navigation", () => {
  it("clears stale job resume state before navigating and preserves unrelated session data", () => {
    const values = new Map([
      ["diger_active_job_id", "old-job"],
      ["diger_canvas_open", "1"],
      ["other-session-value", "keep"],
    ]);
    const storage = { removeItem: vi.fn((key: string) => values.delete(key)) };
    const navigate = vi.fn();

    startNewResearch(navigate, storage);

    expect([...values.entries()]).toEqual([["other-session-value", "keep"]]);
    expect(storage.removeItem.mock.calls).toEqual([["diger_active_job_id"], ["diger_canvas_open"]]);
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("uses the reset path for both the shell and Requests page entry points", () => {
    const shell = readFileSync("src/components/app/AppShell.tsx", "utf8");
    const requests = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");

    expect(shell).toContain('startNewResearch(() => router.push("/dashboard/chat"))');
    expect(requests).toContain('startNewResearch(() => router.push("/dashboard/chat"))');
  });
});
