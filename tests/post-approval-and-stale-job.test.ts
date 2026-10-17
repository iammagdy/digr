import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POST_APPROVAL_MESSAGE_AR } from "../src/lib/postApproval";

const chatPage = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");

describe("post-approval message", () => {
  it("is the exact approved sentence and the chat page shows it after approval", () => {
    expect(POST_APPROVAL_MESSAGE_AR).toBe("جاري سحب البيانات، سيصلك إشعار عند الاكتمال ويمكنك إغلاق الصفحة.");
    expect(chatPage).toContain("content: POST_APPROVAL_MESSAGE_AR");
  });

  it("contains no English, emoji or technical words", () => {
    expect(POST_APPROVAL_MESSAGE_AR).not.toMatch(/[A-Za-z]/);
    expect(POST_APPROVAL_MESSAGE_AR).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

// Static checks: the behavior itself needs a browser session (NOT RUN in this task).
describe("a finished or running job from before «سؤال بحثي جديد» cannot come back", () => {
  const startNewChat = chatPage.slice(chatPage.indexOf("function handleStartNewChat"), chatPage.indexOf("// Save Direct Plan Edits"));

  it("the new-research handler clears the active job, rows, resume hints and the URL", () => {
    expect(startNewChat).toContain("setActiveJob(null)");
    expect(startNewChat).toContain("setExtractedRecords([])");
    expect(startNewChat).toContain("loadedResultJobs.current.clear()");
    expect(startNewChat).toContain('sessionStorage.removeItem("diger_active_job_id")');
    expect(startNewChat).toContain('sessionStorage.removeItem("diger_canvas_open")');
    expect(startNewChat).toContain("syncConversationUrl(null)");
  });

  it("late replies for another job are dropped instead of painted into the new screen", () => {
    expect(chatPage).toContain("activeJobIdRef.current = activeJob?.jobId ?? null");
    expect(chatPage).toContain("if (!(await isStillActiveJob(jobId)))");
    // The poll updater refuses to merge a reply into a different job.
    expect(chatPage).toContain("if (!prev || prev.jobId !== activeJob.jobId) return prev;");
    // Row loading is guarded before any rows are set.
    const loader = chatPage.slice(chatPage.indexOf("async function loadJobResults"), chatPage.indexOf("// 5. Poll and subscribe"));
    expect(loader.indexOf("isStillActiveJob(jobId)")).toBeGreaterThan(-1);
    expect(loader.indexOf("isStillActiveJob(jobId)")).toBeLessThan(loader.indexOf("setExtractedRecords"));
  });
});
