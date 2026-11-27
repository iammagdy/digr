import { describe, expect, it, vi } from "vitest";
import { conversationJobIds, latestDeliveredJob } from "@/lib/server/conversationJobs";
import { getJobIdForQuote } from "@/lib/md5";
import { fakeSupabase } from "./helpers/fakeSupabase";

describe("conversationJobs: agent-mission lookup (P1 / T1)", () => {
  it("delivers job for conversation with an assistant card message carrying plan.agentMissionId", async () => {
    const db = fakeSupabase({
      tables: {
        messages: [
          {
            conversation_id: "conv_1",
            user_id: "user_a",
            created_at: "2026-11-27T10:00:00Z",
            plan: { agentMissionId: "msn_12345678abcdef" },
          },
        ],
        missions: [
          {
            id: "msn_12345678abcdef",
            user_id: "user_a",
            job_id: "job_agent_001",
            plan: { summary_ar: "خطة عادية" },
          },
        ],
        jobs: [
          {
            id: "job_agent_001",
            user_id: "user_a",
            status: "done",
            endpoint_id: "agent-mission",
            created_at: "2026-11-27T10:05:00Z",
          },
        ],
      },
    });

    const jobIds = await conversationJobIds(db, { conversationId: "conv_1", userId: "user_a" });
    expect(jobIds).toEqual(["job_agent_001"]);

    const job = await latestDeliveredJob(db, { conversationId: "conv_1", userId: "user_a" });
    expect(job).not.toBeNull();
    expect(job?.id).toBe("job_agent_001");
  });

  it("legacy conversation without agent card makes 0 missions queries", async () => {
    const missionsSpy = vi.fn();
    const db = fakeSupabase({
      tables: {
        messages: [
          {
            conversation_id: "conv_legacy",
            user_id: "user_a",
            created_at: "2026-11-27T10:00:00Z",
            quote: { quoteId: "q_legacy_1" },
          },
        ],
        missions: [],
      },
    });
    const origFrom = db.from;
    db.from = (table: string) => {
      if (table === "missions") missionsSpy();
      return origFrom(table);
    };

    const jobIds = await conversationJobIds(db, { conversationId: "conv_legacy", userId: "user_a" });
    expect(jobIds.length).toBe(1);
    expect(jobIds[0]).toMatch(/^job_quote_/);
    expect(missionsSpy).not.toHaveBeenCalled();
  });

  it("undelivered agent job is included in conversationJobIds but skipped by latestDeliveredJob", async () => {
    const db = fakeSupabase({
      tables: {
        messages: [
          {
            conversation_id: "conv_running",
            user_id: "user_a",
            created_at: "2026-11-27T10:00:00Z",
            plan: { agentMissionId: "msn_running12345" },
          },
        ],
        missions: [
          {
            id: "msn_running12345",
            user_id: "user_a",
            job_id: "job_running_001",
            plan: {},
          },
        ],
        jobs: [
          {
            id: "job_running_001",
            user_id: "user_a",
            status: "running",
            endpoint_id: "agent-mission",
            created_at: "2026-11-27T10:05:00Z",
          },
        ],
      },
    });

    const jobIds = await conversationJobIds(db, { conversationId: "conv_running", userId: "user_a" });
    expect(jobIds).toEqual(["job_running_001"]);

    const job = await latestDeliveredJob(db, { conversationId: "conv_running", userId: "user_a" });
    expect(job).toBeNull();
  });

  it("user B cannot see user A conversation", async () => {
    const db = fakeSupabase({
      tables: {
        messages: [
          {
            conversation_id: "conv_a",
            user_id: "user_a",
            created_at: "2026-11-27T10:00:00Z",
            plan: { agentMissionId: "msn_usera1234567" },
          },
        ],
        missions: [
          {
            id: "msn_usera1234567",
            user_id: "user_a",
            job_id: "job_user_a",
          },
        ],
        jobs: [
          {
            id: "job_user_a",
            user_id: "user_a",
            status: "done",
            created_at: "2026-11-27T10:05:00Z",
          },
        ],
      },
    });

    const job = await latestDeliveredJob(db, { conversationId: "conv_a", userId: "user_b" });
    expect(job).toBeNull();
  });

  it("drops mission reference belonging to user B seeded in user A message", async () => {
    const db = fakeSupabase({
      tables: {
        messages: [
          {
            conversation_id: "conv_cross",
            user_id: "user_a",
            created_at: "2026-11-27T10:00:00Z",
            plan: { agentMissionId: "msn_userb1234567" },
          },
        ],
        missions: [
          {
            id: "msn_userb1234567",
            user_id: "user_b",
            job_id: "job_user_b",
          },
        ],
      },
    });

    const jobIds = await conversationJobIds(db, { conversationId: "conv_cross", userId: "user_a" });
    expect(jobIds).toEqual([]);
  });

  it("excludes mission with hasAddonMarker from conversationJobIds", async () => {
    const db = fakeSupabase({
      tables: {
        messages: [
          {
            conversation_id: "conv_addon",
            user_id: "user_a",
            created_at: "2026-11-27T10:00:00Z",
            plan: { agentMissionId: "msn_addon1234567" },
          },
        ],
        missions: [
          {
            id: "msn_addon1234567",
            user_id: "user_a",
            job_id: "job_addon_001",
            plan: { addon: { kind: "review" } },
          },
        ],
      },
    });

    const jobIds = await conversationJobIds(db, { conversationId: "conv_addon", userId: "user_a" });
    expect(jobIds).toEqual([]);
  });

  it("conversation with quote AND agent mission selects newest delivered", async () => {
    const db = fakeSupabase({
      tables: {
        messages: [
          {
            conversation_id: "conv_mixed",
            user_id: "user_a",
            created_at: "2026-11-27T10:00:00Z",
            quote: { quoteId: "q_older" },
          },
          {
            conversation_id: "conv_mixed",
            user_id: "user_a",
            created_at: "2026-11-27T10:10:00Z",
            plan: { agentMissionId: "msn_newer1234567" },
          },
        ],
        missions: [
          {
            id: "msn_newer1234567",
            user_id: "user_a",
            job_id: "job_newer_agent",
          },
        ],
        jobs: [
          {
            id: getJobIdForQuote("q_older"),
            user_id: "user_a",
            status: "done",
            created_at: "2026-11-27T10:02:00Z",
          },
          {
            id: "job_newer_agent",
            user_id: "user_a",
            status: "done",
            created_at: "2026-11-27T10:15:00Z",
          },
        ],
      },
    });

    const job = await latestDeliveredJob(db, { conversationId: "conv_mixed", userId: "user_a" });
    expect(job?.id).toBe("job_newer_agent");
  });

  it("mission without job_id is skipped", async () => {
    const db = fakeSupabase({
      tables: {
        messages: [
          {
            conversation_id: "conv_no_job",
            user_id: "user_a",
            created_at: "2026-11-27T10:00:00Z",
            plan: { agentMissionId: "msn_nojob1234567" },
          },
        ],
        missions: [
          {
            id: "msn_nojob1234567",
            user_id: "user_a",
            job_id: null,
          },
        ],
      },
    });

    const jobIds = await conversationJobIds(db, { conversationId: "conv_no_job", userId: "user_a" });
    expect(jobIds).toEqual([]);
  });

  it("missions DB read failure gracefully falls back to quote jobIds", async () => {
    const db = fakeSupabase({
      tables: {
        messages: [
          {
            conversation_id: "conv_err",
            user_id: "user_a",
            created_at: "2026-11-27T10:00:00Z",
            quote: { quoteId: "q_safe" },
            plan: { agentMissionId: "msn_fail12345678" },
          },
        ],
      },
    });
    const origFrom = db.from;
    db.from = (table: string) => {
      if (table === "missions") {
        throw new Error("DB connection failure");
      }
      return origFrom(table);
    };

    const jobIds = await conversationJobIds(db, { conversationId: "conv_err", userId: "user_a" });
    expect(jobIds.length).toBe(1);
    expect(jobIds[0]).toMatch(/^job_quote_/);
  });
});
