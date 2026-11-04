/**
 * STAGE 4 FLAGS (docs/STAGE-4.md). Each is OFF unless its environment variable says exactly «on» (every account) or «test» (test accounts only). Unset, empty or any other word is off.
 * Nothing in this branch reads them on a customer path. NO CHARGE is wired to any of them: charging waits for the separate money PR (FOUNDATION-PLAN PR 7).
 */
export const STAGE4_FLAGS = ["DIGER_STAGE4_VERSIONS", "DIGER_STAGE4_REVIEW", "DIGER_STAGE4_EDITS"] as const;
export type Stage4Flag = (typeof STAGE4_FLAGS)[number];
export type StageFlagMode = "off" | "test" | "on";

type Env = Readonly<Record<string, string | undefined>>;
const processEnv = (): Env => (typeof process !== "undefined" && process.env ? process.env : {});

export function stage4FlagMode(name: Stage4Flag, env: Env = processEnv()): StageFlagMode {
  const v = String(env[name] ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "test" ? "test" : "off";
}

export function stage4Enabled(name: Stage4Flag, isTestAccount: boolean, env: Env = processEnv()): boolean {
  const mode = stage4FlagMode(name, env);
  return mode === "on" || (mode === "test" && isTestAccount === true);
}
