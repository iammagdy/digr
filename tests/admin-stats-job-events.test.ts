import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { finishedJobLabelAr, FINISHED_JOB_STATUS, isFinishedJob } from "../src/lib/server/adminJobEvents";

/**
 * The admin stats read the jobs table as it is: the finished status is «completed» and a finished job's delivered records are `deliveredUnits`
 * (the column). Evidence: the stats route still tested «done» and read a column that does not exist, so a finished job showed as running with 0 records.
 */
describe("the admin stats read the finished job the way the table stores it", () => {
  it("«completed» is finished, «done» is not, and the label gives the delivered records in Arabic-Indic digits", () => {
    expect(FINISHED_JOB_STATUS).toBe("completed");
    expect(isFinishedJob("completed")).toBe(true);
    expect(isFinishedJob("done")).toBe(false);
    expect(isFinishedJob("running")).toBe(false);
    expect(finishedJobLabelAr({ deliveredUnits: 12 })).toBe("اكتمل بحثه · ١٢ سجلًا");
    expect(finishedJobLabelAr({ deliveredUnits: null })).toBe("اكتمل بحثه · ٠ سجلًا");
  });
  it("the stats route uses the helper and no longer reads «done» or «rowsCollected»", () => {
    const route = readFileSync("src/app/api/admin/stats/route.ts", "utf8");
    expect(route).toContain("finishedJobLabelAr(j)");
    expect(route).toContain("isFinishedJob(j.status)");
    expect(route).not.toContain("rowsCollected");
    expect(route).not.toContain('j.status === "done"');
  });
});
