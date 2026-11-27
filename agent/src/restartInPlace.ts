/**
 * AN IN-PLACE RESTART (DT-20261126-planning-budget-llm FU-C). An idle worker whose memory stays at the admit limit asks for a restart with a fresh heap (worker.ts: `onRecycle`). Exiting made the platform see a CRASH
 * (Heroku counts even exit status 0 as a dyno crash: the first restart is immediate, a second crash within the cool-off is delayed, so the queue waited minutes and the chat said the service was paused).
 * `process.execve` replaces the running program with a new copy of itself IN THE SAME PROCESS (same pid, same flags, same environment, a fresh heap): the platform never sees an exit, and the worker is back in seconds.
 * Only for a recycle, never for a platform stop (SIGTERM/SIGINT must exit so a deploy replaces the code). Where `process.execve` does not exist (Node before 22.15) or fails, the caller exits as before.
 */
export interface RestartInPlaceDeps {
  /** `process.execve` where the Node version has it. */
  execve?: ((file: string, args?: readonly string[], env?: NodeJS.ProcessEnv) => never) | undefined;
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

/** Replaces this process with a fresh copy of itself. Returns false (nothing replaced) when that is not possible; on success it never returns. */
export function restartInPlace(deps: RestartInPlaceDeps): boolean {
  if (typeof deps.execve !== "function") {
    deps.log("recycle: process.execve is not available on this Node: exiting for the platform to restart");
    return false;
  }
  try {
    deps.log("recycle: restarting this process in place (same pid, fresh heap)");
    deps.execve(deps.execPath, [deps.execPath, ...deps.execArgv, ...deps.argv.slice(1)], deps.env);
  } catch (error) {
    deps.log(`recycle: the in-place restart failed (${String((error as Error)?.message ?? error).slice(0, 120)}): exiting for the platform to restart`);
  }
  return false;
}

/** The decision, in one place: restart in place only for a recycle that is not part of a platform stop. */
export function shouldRestartInPlace(state: { recycleRequested: boolean; platformStop: boolean }): boolean {
  return state.recycleRequested && !state.platformStop;
}
