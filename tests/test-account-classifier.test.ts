import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hidesTestAccounts, isTestAccountEmail as toggleSaysTest, testAccountIds } from "../src/lib/server/adminTestAccounts";
import { isTestAccount, isTestAccountEmail, TEST_ACCOUNT_IDS } from "../src/lib/server/testAccounts";

const TEST_ACCOUNTS = ["test_concurrency@digr.local", "test_accept@digr.local", "iam.magdy@outlook.com", "iam.magdy+1@outlook.com"];
const NOT_TEST = [
  "magdy.saber@outlook.com", // the owner / admin: not a test account (owner decision pending, never hidden)
  "hala.elalfy2026@gmail.com", "badrp595@gmail.com", // real customers
  "iam.magdy@outlook.com.evil.com", "iam.magdy+1@outlook.com.evil.com", "xiam.magdy@outlook.com", "xiam.magdy+1@outlook.com", "iam.magdy@evil.com", "iam.magdy+1@evil.com",
  "iam.magdy+a@b@outlook.com", "iam.magdy+ @outlook.com", "iam.magdy2@outlook.com", "iam-magdy@outlook.com", "x@digr.local.evil.com", "digr.local", "test@digr.localhost", "",
];

describe("ONE classifier decides what is a test account", () => {
  it("the four test accounts are test accounts, in any case and with spaces around", () => {
    for (const email of TEST_ACCOUNTS) {
      expect(isTestAccountEmail(email), email).toBe(true);
      expect(isTestAccountEmail(`  ${email.toUpperCase()} `), email).toBe(true);
      expect(isTestAccount({ email }), email).toBe(true);
    }
    for (const email of ["iam.magdy+2@outlook.com", "iam.magdy+conference.day-1@outlook.com", "anything@digr.local"]) expect(isTestAccountEmail(email), email).toBe(true);
  });

  it("the owner, the real customers and look-alike addresses are never test accounts", () => {
    for (const email of NOT_TEST) {
      expect(isTestAccountEmail(email), email).toBe(false);
      expect(isTestAccount({ email }), email).toBe(false);
    }
    expect(isTestAccount({})).toBe(false);
    expect(isTestAccount({ id: null, email: null })).toBe(false);
  });

  it("the known test user ids are test accounts whatever their e-mail", () => {
    expect([...TEST_ACCOUNT_IDS]).toEqual(["47693c59-89f1-405d-bec1-e72271517870", "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"]);
    for (const id of TEST_ACCOUNT_IDS) {
      expect(isTestAccount({ id }), id).toBe(true);
      expect(isTestAccount({ id: id.toUpperCase(), email: "someone@example.com" }), id).toBe(true);
    }
    expect(isTestAccount({ id: "47693c59-89f1-405d-bec1-e72271517871" })).toBe(false);
  });

  it("the toggle (Jobs and Conference pages) and the calls log give the same answer for every address", () => {
    for (const email of [...TEST_ACCOUNTS, ...NOT_TEST, "IAM.MAGDY+9@OUTLOOK.COM", "Test@Digr.Local"]) {
      expect(toggleSaysTest(email), email).toBe(isTestAccount({ email }));
    }
  });

  it("the toggle's id set takes the profile rows as the pages read them: the four test accounts are in, the owner and the customers are out", () => {
    const profiles = [
      { id: "u1", email: "test_concurrency@digr.local" }, { id: "u2", email: "test_accept@digr.local" }, { id: "u3", email: "iam.magdy@outlook.com" }, { id: "u4", email: "iam.magdy+1@outlook.com" },
      { id: "owner", email: "magdy.saber@outlook.com" }, { id: "hala", email: "hala.elalfy2026@gmail.com" }, { id: "badr", email: "badrp595@gmail.com" },
      { id: "47693c59-89f1-405d-bec1-e72271517870", email: null }, { id: 7, email: "x@digr.local" }, { id: null, email: "y@digr.local" },
    ];
    expect([...testAccountIds(profiles)].sort()).toEqual(["47693c59-89f1-405d-bec1-e72271517870", "u1", "u2", "u3", "u4"]);
  });

  it("the defaults are unchanged: the toggle is on unless the request says hideTest=0", () => {
    expect(hidesTestAccounts(null)).toBe(true);
    expect(hidesTestAccounts(undefined)).toBe(true);
    expect(hidesTestAccounts("1")).toBe(true);
    expect(hidesTestAccounts("0")).toBe(false);
    expect(readFileSync("src/app/admin/jobs/page.tsx", "utf8")).toContain("useState(true)");
    expect(readFileSync("src/app/admin/conference/page.tsx", "utf8")).toContain("useState(true)");
  });

  it("there is only one list: adminTestAccounts.ts holds none of its own and the calls log imports the shared classifier", () => {
    const toggle = readFileSync("src/lib/server/adminTestAccounts.ts", "utf8");
    expect(toggle).toContain('from "./testAccounts"');
    expect(toggle).not.toMatch(/@outlook\.com|digr\.local"|\[\s*"iam/);
    expect(readFileSync("src/lib/server/adminCallsLog.ts", "utf8")).toContain('import { isTestAccount } from "./testAccounts";');
  });

  it("it only classifies: no write, no database access in either file", () => {
    for (const file of ["src/lib/server/testAccounts.ts", "src/lib/server/adminTestAccounts.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/supabase|\.from\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/);
    }
  });
});
