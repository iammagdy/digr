import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_MAX_HEAP_MB, SANDBOX_MAX_INPUT_BYTES, SANDBOX_MAX_OUTPUT_BYTES, SANDBOX_TIMEOUT_MS } from "../../../src/lib/agentMission/constants";

/**
 * run_code's engine: the model's JavaScript runs in a SEPARATE node process that has
 *  - an empty environment (no key, no token, no PATH),
 *  - Node's permission model on (`--permission`: no file access except its own runner script, no child process, no worker, no native addon),
 *  - a heap limit and a wall-clock limit (the parent kills it),
 *  - and, inside it, a fresh vm context with no require / process / fetch / Buffer / timers and string code generation switched off (see runner.cjs).
 * It receives only the data the caller hands it (the mission's own saved files, read by the caller from the mission's own storage prefix) as one JSON string.
 *
 * NOT PROVEN: a node vm context is not a security boundary against an unknown engine bug, and the permission model of Node 22 does not restrict the network. The layers above make a
 * script with no network API unable to open a connection; an OS-level network jail (a container with no route out) is not in place on a Heroku dyno. See agent/README.md.
 */
const here = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
export const SANDBOX_RUNNER_PATH = path.join(here, "runner.cjs");

export interface SandboxOptions {
  timeoutMs?: number;
  heapMb?: number;
  /** Test hook: environment of the child (it is ALWAYS empty in production). */
  env?: Record<string, string>;
}

export type SandboxResult =
  | { ok: true; resultJson: string | null; logs: string[] }
  | { ok: false; error: string; logs: string[] };

export async function runInSandbox(code: string, inputs: Record<string, unknown>, options: SandboxOptions = {}): Promise<SandboxResult> {
  const inputsJson = JSON.stringify(inputs);
  if (Buffer.byteLength(inputsJson) > SANDBOX_MAX_INPUT_BYTES) return { ok: false, error: "the files given to the code are too large", logs: [] };
  const timeoutMs = options.timeoutMs ?? SANDBOX_TIMEOUT_MS;
  const request = JSON.stringify({ code, inputs: inputsJson, timeoutMs });

  return new Promise<SandboxResult>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--permission", `--allow-fs-read=${SANDBOX_RUNNER_PATH}`, `--max-old-space-size=${options.heapMb ?? SANDBOX_MAX_HEAP_MB}`, SANDBOX_RUNNER_PATH],
      { env: (options.env ?? {}) as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    let overflow = false;
    let settled = false;
    const done = (r: SandboxResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); done({ ok: false, error: "the code ran out of time", logs: [] }); }, timeoutMs + 2_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > SANDBOX_MAX_OUTPUT_BYTES) { overflow = true; child.kill("SIGKILL"); }
    });
    child.stderr.on("data", () => { /* never forwarded: it can only be the runtime's own message */ });
    child.on("error", () => done({ ok: false, error: "the sandbox could not start", logs: [] }));
    child.on("close", (status, signal) => {
      if (overflow) return done({ ok: false, error: "the result is too large; return a smaller value or save only what is needed", logs: [] });
      if (status !== 0) return done({ ok: false, error: signal ? "the code used too much memory or was stopped" : "the code stopped the sandbox", logs: [] });
      try {
        const line = out.trim().split("\n").pop() ?? "";
        const parsed = JSON.parse(line) as { ok: boolean; result: string | null; logs: string[]; error: string | null };
        if (parsed.ok) done({ ok: true, resultJson: parsed.result, logs: parsed.logs ?? [] });
        else done({ ok: false, error: String(parsed.error ?? "error").slice(0, 500), logs: parsed.logs ?? [] });
      } catch {
        done({ ok: false, error: "the sandbox gave no answer", logs: [] });
      }
    });
    child.stdin.on("error", () => { /* the child may have died before reading */ });
    child.stdin.end(request);
  });
}
