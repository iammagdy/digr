import { describe, it, expect } from "vitest";
import { shouldShowProgressNotice, applyJobRow } from "../src/lib/jobs/progressNotice";

describe("Task 7: Job Poll State & Progress Notice Robustness", () => {
  describe("shouldShowProgressNotice", () => {
    it("returns false when job status is 'done'", () => {
      expect(
        shouldShowProgressNotice(
          { jobId: "a", progressNotice: true },
          { jobId: "a", status: "done" }
        )
      ).toBe(false);
    });

    it("returns false when job status is 'completed'", () => {
      expect(
        shouldShowProgressNotice(
          { jobId: "a", progressNotice: true },
          { jobId: "a", status: "completed" }
        )
      ).toBe(false);
    });

    it("returns false when job status is 'failed'", () => {
      expect(
        shouldShowProgressNotice(
          { jobId: "a", progressNotice: true },
          { jobId: "a", status: "failed" }
        )
      ).toBe(false);
    });

    it("returns true when job status is 'running'", () => {
      expect(
        shouldShowProgressNotice(
          { jobId: "a", progressNotice: true },
          { jobId: "a", status: "running" }
        )
      ).toBe(true);
    });

    it("returns true when job status is 'queued'", () => {
      expect(
        shouldShowProgressNotice(
          { jobId: "a", progressNotice: true },
          { jobId: "a", status: "queued" }
        )
      ).toBe(true);
    });

    it("returns false when activeJob is null", () => {
      expect(
        shouldShowProgressNotice(
          { jobId: "a", progressNotice: true },
          null
        )
      ).toBe(false);
    });

    it("returns false when activeJob is undefined", () => {
      expect(
        shouldShowProgressNotice(
          { jobId: "a", progressNotice: true },
          undefined
        )
      ).toBe(false);
    });

    it("returns false when message is not a progress notice", () => {
      expect(
        shouldShowProgressNotice(
          { jobId: "a", progressNotice: false },
          { jobId: "a", status: "running" }
        )
      ).toBe(false);
    });

    it("returns false when message jobId does not match activeJob jobId", () => {
      expect(
        shouldShowProgressNotice(
          { jobId: "a", progressNotice: true },
          { jobId: "b", status: "running" }
        )
      ).toBe(false);
    });

    it("returns false when terminalJobs map records this job as terminal, even if activeJob is still 'running'", () => {
      const terminalMap = new Map<string, boolean>([["a", true]]);
      expect(
        shouldShowProgressNotice(
          { jobId: "a", progressNotice: true },
          { jobId: "a", status: "running" },
          terminalMap
        )
      ).toBe(false);
    });

    it("returns false when terminalJobs set records this job as terminal", () => {
      const terminalSet = new Set<string>(["a"]);
      expect(
        shouldShowProgressNotice(
          { jobId: "a", progressNotice: true },
          { jobId: "a", status: "running" },
          terminalSet
        )
      ).toBe(false);
    });
  });

  describe("applyJobRow", () => {
    it("maps status 'completed' to 'done'", () => {
      const result = applyJobRow(null, { status: "completed" });
      expect(result.status).toBe("done");
    });

    it("maps status 'failed' to 'failed'", () => {
      const result = applyJobRow(null, { status: "failed" });
      expect(result.status).toBe("failed");
    });

    it("maps status 'refused' to 'failed'", () => {
      const result = applyJobRow(null, { status: "refused" });
      expect(result.status).toBe("failed");
    });

    it("maps status 'cancelled' to 'cancelled'", () => {
      const result = applyJobRow(null, { status: "cancelled" });
      expect(result.status).toBe("cancelled");
    });

    it("maps status 'running' to 'running'", () => {
      const result = applyJobRow(null, { status: "running" });
      expect(result.status).toBe("running");
    });

    it("maps status 'queued' to 'queued'", () => {
      const result = applyJobRow(null, { status: "queued" });
      expect(result.status).toBe("queued");
    });

    it("preserves and updates row fields including delivered units, credits, and error", () => {
      const prev = {
        jobId: "job-1",
        status: "running" as const,
        rowsCollected: 5,
        updatedAt: "2026-10-19T10:00:00Z",
      };
      const row = {
        id: "job-1",
        status: "completed",
        delivered_units: 25,
        charged_credits: 150,
        reserved_credits: 172,
        target_volume_max: 30,
        error_message: null,
        updated_at: "2026-10-19T10:05:00Z",
      };
      const next = applyJobRow(prev, row);
      expect(next.jobId).toBe("job-1");
      expect(next.status).toBe("done");
      expect(next.rowsCollected).toBe(25);
      expect(next.chargedCredits).toBe(150);
      expect(next.reservedCredits).toBe(172);
      expect(next.requestedRows).toBe(30);
      expect(next.updatedAt).toBe("2026-10-19T10:05:00Z");
    });
  });
});
