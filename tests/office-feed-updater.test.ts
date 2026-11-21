import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  buildOfficeFeed,
  CANONICAL_BOTS,
  BOT_ROLES,
  readTaskStatus,
  getNewestFileMtime,
} from "../scripts/office-feed-updater.mjs";

describe("DT-20261121-office-v2: Feed updater logic & CTO corrections", () => {
  it("CTO correction 2: waiting comes from explicit fields only (status.md or jsonl state), never keywords", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-feed-test-"));
    const statusDir = path.join(tmpDir, "status");
    const tasksDir = path.join(tmpDir, "tasks");
    const workDir = path.join(tmpDir, "work");
    fs.mkdirSync(statusDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });

    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();

    // 1. Bot silent 2h with state waiting in status.md -> waiting, NOT stuck
    const waitTaskDir = path.join(tasksDir, "DT-WAIT-01");
    fs.mkdirSync(waitTaskDir, { recursive: true });
    fs.writeFileSync(
      path.join(waitTaskDir, "status.md"),
      "state: waiting\npercent: 45\nstep: waiting for CI\n"
    );
    fs.writeFileSync(
      path.join(statusDir, "salem.jsonl"),
      JSON.stringify({
        bot: "salem",
        state: "working",
        task_id: "DT-WAIT-01",
        updated_at: twoHoursAgo,
        open_order: true,
      }) + "\n"
    );

    // 2. Counter-case: Fazza reviewing with step text «فحص الجودة» and state working -> working, NOT waiting
    const fazzaTaskDir = path.join(tasksDir, "DT-REV-01");
    fs.mkdirSync(fazzaTaskDir, { recursive: true });
    fs.writeFileSync(
      path.join(fazzaTaskDir, "status.md"),
      "state: working\npercent: 60\nstep: فحص الجودة والمراجعة المعمارية\n"
    );
    const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(statusDir, "fazza.jsonl"),
      JSON.stringify({
        bot: "fazza",
        state: "working",
        task_id: "DT-REV-01",
        step: "فحص الجودة والمراجعة المعمارية",
        updated_at: tenMinAgo,
        open_order: true,
      }) + "\n"
    );

    // 3. Bot with state working and no activity > 45 min -> stuck
    const stuckTaskDir = path.join(tasksDir, "DT-STUCK-01");
    fs.mkdirSync(stuckTaskDir, { recursive: true });
    fs.writeFileSync(
      path.join(stuckTaskDir, "status.md"),
      "state: working\npercent: 30\n"
    );
    const fiftyMinAgo = new Date(now - 50 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(statusDir, "hagras.jsonl"),
      JSON.stringify({
        bot: "hagras",
        state: "working",
        task_id: "DT-STUCK-01",
        updated_at: fiftyMinAgo,
        open_order: true,
      }) + "\n"
    );

    const workDirs: Record<string, string> = {
      salem: path.join(workDir, "salem"),
      fazza: path.join(workDir, "fazza"),
      hagras: path.join(workDir, "hagras"),
    };
    for (const d of Object.values(workDirs)) fs.mkdirSync(d, { recursive: true });

    const feed = (buildOfficeFeed as any)({
      statusDir,
      tasksDir,
      workDirs,
      openPrs: [{ number: 123, title: "Secret title" }],
      nowMs: now,
    });

    // Verify Salem: state waiting after 2 hours
    expect(feed.bots.salem.state).toBe("waiting");
    expect(feed.bots.salem.activity_type).toBe("في انتظار الفحص الآلي");

    // Verify Fazza: state working despite «فحص» in step text
    expect(feed.bots.fazza.state).toBe("working");
    expect(feed.bots.fazza.activity_type).toBe("مراجعة فنية ومعمارية");

    // Verify Hagras: state stuck after 50 min of inactivity
    expect(feed.bots.hagras.state).toBe("stuck");
  });

  it("CTO correction 3: real percent from status.md (e.g. 72), no task -> null", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-feed-test-pct-"));
    const statusDir = path.join(tmpDir, "status");
    const tasksDir = path.join(tmpDir, "tasks");
    fs.mkdirSync(statusDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });

    const now = Date.now();
    const taskDir = path.join(tasksDir, "DT-72");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "status.md"),
      "state: working\npercent: 72\nstep: deep test\n"
    );

    // Johnny has task DT-72
    fs.writeFileSync(
      path.join(statusDir, "johnny.jsonl"),
      JSON.stringify({
        bot: "johnny",
        state: "working",
        task_id: "DT-72",
        percent: 50, // jsonl says 50, status.md says 72
        updated_at: new Date(now).toISOString(),
        open_order: true,
      }) + "\n"
    );

    // Nafady is idle without a task
    fs.writeFileSync(
      path.join(statusDir, "nafady.jsonl"),
      JSON.stringify({
        bot: "nafady",
        state: "idle",
        task_id: null,
        percent: 0,
        updated_at: new Date(now).toISOString(),
        open_order: false,
      }) + "\n"
    );

    const feed = (buildOfficeFeed as any)({
      statusDir,
      tasksDir,
      openPrs: [],
      nowMs: now,
    });

    // Johnny has exact 72% from status.md
    expect(feed.bots.johnny.percent).toBe(72);

    // Nafady has null percent (no percent shown for idle / no task)
    expect(feed.bots.nafady.percent).toBeNull();
  });

  it("CTO correction 4: activity = max(newest file mtime in bot work folder, jsonl updated_at)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-feed-test-mtime-"));
    const statusDir = path.join(tmpDir, "status");
    const workDir = path.join(tmpDir, "work", "marbouha");
    fs.mkdirSync(statusDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });

    const now = Date.now();
    // jsonl updated 50 min ago (would be stuck if only jsonl was checked)
    const fiftyMinAgo = new Date(now - 50 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(statusDir, "marbouha.jsonl"),
      JSON.stringify({
        bot: "marbouha",
        state: "working",
        task_id: "DT-WORK-1",
        updated_at: fiftyMinAgo,
        open_order: true,
      }) + "\n"
    );

    // But file in work directory modified 5 minutes ago!
    const activeFilePath = path.join(workDir, "temp-test.ts");
    fs.writeFileSync(activeFilePath, "console.log('active');");
    const fiveMinAgoDate = new Date(now - 5 * 60 * 1000);
    fs.utimesSync(activeFilePath, fiveMinAgoDate, fiveMinAgoDate);

    const workDirs: Record<string, string> = {
      marbouha: workDir,
    };

    const feed = (buildOfficeFeed as any)({
      statusDir,
      workDirs,
      openPrs: [],
      nowMs: now,
    });

    // Marbouha is NOT stuck because file mtime is fresh (5 min ago)
    expect(feed.bots.marbouha.state).toBe("working");
    expect(feed.bots.marbouha.last_active).toBe(
      fiveMinAgoDate.toISOString().replace(/\.\d{3}Z$/, "Z")
    );
  });

  it("CTO correction 5 & Spec Test 3: published JSON has no task_id, step, next, branch, PR titles; open_prs is count only", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-feed-test-clean-"));
    const statusDir = path.join(tmpDir, "status");
    const tasksDir = path.join(tmpDir, "tasks");
    fs.mkdirSync(statusDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });

    const now = Date.now();
    const taskDir = path.join(tasksDir, "DT-20261121-secret");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "status.md"),
      "state: working\npercent: 80\nstep: running internal /srv/tests/test.ts\nnext: commit refs/pull/608\n"
    );

    fs.writeFileSync(
      path.join(statusDir, "elkebir.jsonl"),
      JSON.stringify({
        bot: "elkebir",
        state: "working",
        task_id: "DT-20261121-secret",
        task_title: "O6-secret internal task",
        step: "running /srv/diger-team/test.ts",
        next: "push refs/pull/608",
        percent: 80,
        updated_at: new Date(now).toISOString(),
        open_order: true,
      }) + "\n"
    );

    const feed = (buildOfficeFeed as any)({
      statusDir,
      tasksDir,
      openPrs: [
        { number: 608, title: "DT-20261121-secret PR" },
        { number: 609, title: "refs/pull/609/head" },
      ],
      nowMs: now,
    });

    // open_prs must be a count only
    expect(typeof feed.open_prs).toBe("number");
    expect(feed.open_prs).toBe(2);

    // Bot fields must contain only allowed keys
    const elkebir = feed.bots.elkebir;
    expect(elkebir).toHaveProperty("bot", "elkebir");
    expect(elkebir).toHaveProperty("role");
    expect(elkebir).toHaveProperty("state", "working");
    expect(elkebir).toHaveProperty("activity_type", "متابعة وإشراف تقني");
    expect(elkebir).toHaveProperty("percent", 80);
    expect(elkebir).toHaveProperty("last_active");

    // MUST NOT have internal fields
    expect(elkebir).not.toHaveProperty("task_id");
    expect(elkebir).not.toHaveProperty("task_title");
    expect(elkebir).not.toHaveProperty("step");
    expect(elkebir).not.toHaveProperty("next");
    expect(elkebir).not.toHaveProperty("branch");

    // Write status.json and run Spec Test 3 grep check
    const statusJsonPath = path.join(tmpDir, "status.json");
    fs.writeFileSync(statusJsonPath, JSON.stringify(feed, null, 2), "utf8");

    let grepOutput = "";
    let grepFailed = false;
    try {
      grepOutput = execSync(
        `grep -E "DT-[0-9]{8}|O6-|/srv/|\\.ts\\b|refs/pull" "${statusJsonPath}"`,
        { encoding: "utf8" }
      );
    } catch (err: any) {
      // grep exit code 1 means NO match found (which is what we want!)
      grepFailed = err.status === 1;
    }

    expect(grepFailed).toBe(true);
    expect(grepOutput.trim()).toBe("");
  });
});
