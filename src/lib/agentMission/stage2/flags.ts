/**
 * STAGE 2 FLAGS (docs/STAGE-2.md). Every Stage 2 behaviour sits behind one of these, and each is OFF unless its environment variable says exactly «on» (every account) or «test» (test
 * accounts only). Unset, empty or any other word is off, so nothing changes for a customer until the owner sets one. Nothing in this branch reads them on a customer path yet: the
 * wiring (docs/STAGE-2.md, «Left for Sonnet») reads them before it shows anything new.
 */
export const STAGE2_FLAGS = ["DIGER_STAGE2_ASK_CARD", "DIGER_STAGE2_QUESTION_CARDS", "DIGER_STAGE2_LIVE_SHEET"] as const;
export type Stage2Flag = (typeof STAGE2_FLAGS)[number];
export type StageFlagMode = "off" | "test" | "on";

type Env = Readonly<Record<string, string | undefined>>;
const processEnv = (): Env => (typeof process !== "undefined" && process.env ? process.env : {});

/** The mode a flag is in: «on» and «test» only when written exactly so (case and spaces ignored); anything else is off. */
export function stage2FlagMode(name: Stage2Flag, env: Env = processEnv()): StageFlagMode {
  const v = String(env[name] ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "test" ? "test" : "off";
}

/** Whether a flag is on for this account: «on» for every account, «test» for a test account only. */
export function stage2Enabled(name: Stage2Flag, isTestAccount: boolean, env: Env = processEnv()): boolean {
  const mode = stage2FlagMode(name, env);
  return mode === "on" || (mode === "test" && isTestAccount === true);
}

/**
 * «test» MODE ON THE SITE (Sonnet session): the site must not import the test-account rule (the admin screens and the worker own it; the guard
 * tests/admin-calls-log.test.ts keeps it out of customer code). So the WORKER, which already decides whether a mission's account is a test account (redesign.ts `accountIsTest`), writes this
 * create-only marker in the mission's folder when the account is one and some Stage 2 flag says «test»; the site reads only the marker. Flags unset or «on»: nothing is written or read.
 */
export const STAGE2_TEST_MARKER_FOLDER = "stage2";
export const STAGE2_TEST_MARKER_NAME = "test_account.json";
export const STAGE2_TEST_MARKER = `${STAGE2_TEST_MARKER_FOLDER}/${STAGE2_TEST_MARKER_NAME}`;
export const anyStage2TestMode = (env: Env = processEnv()): boolean => STAGE2_FLAGS.some((f) => stage2FlagMode(f, env) === "test");
