/**
 * STAGE 3 FLAGS (docs/STAGE-3.md). Each is OFF unless its environment variable says exactly «on» (every account) or «test» (test accounts only). Unset, empty or any other word is off.
 * Nothing in this branch reads them on a customer path: the wiring (docs/STAGE-3.md, «Left for Sonnet») reads them before anything new is shown or sent.
 */
export const STAGE3_FLAGS = ["DIGER_STAGE3_COMPANIES", "DIGER_STAGE3_QUEUE", "DIGER_STAGE3_EMAIL_NOTICE"] as const;
export type Stage3Flag = (typeof STAGE3_FLAGS)[number];
export type StageFlagMode = "off" | "test" | "on";

type Env = Readonly<Record<string, string | undefined>>;
const processEnv = (): Env => (typeof process !== "undefined" && process.env ? process.env : {});

export function stage3FlagMode(name: Stage3Flag, env: Env = processEnv()): StageFlagMode {
  const v = String(env[name] ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "test" ? "test" : "off";
}

export function stage3Enabled(name: Stage3Flag, isTestAccount: boolean, env: Env = processEnv()): boolean {
  const mode = stage3FlagMode(name, env);
  return mode === "on" || (mode === "test" && isTestAccount === true);
}
