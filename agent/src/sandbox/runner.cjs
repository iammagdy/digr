"use strict";
/*
 * The sandbox RUNNER. It is started by agent/src/sandbox/index.ts as a separate process:
 *   node --permission --allow-fs-read=<this file> --max-old-space-size=<MB> runner.cjs
 * with an EMPTY environment (no ANTHROPIC_API_KEY, no TREG_TOKEN, no Supabase key, no PATH), no network client in the code it runs, and a hard time limit enforced by the parent.
 *
 * `--permission` denies file reads/writes (except this file), child processes, worker threads, native addons and WASI to this process.
 * The model's code runs in a fresh `vm` context that holds NO object of this realm: the data comes in as a JSON STRING and is parsed INSIDE the context, so the code can reach
 * nothing but its own copy of the standard JavaScript built-ins (no require, process, fetch, Buffer, setTimeout, import()). String code generation (eval, new Function) is switched off in
 * the context, so the usual constructor-chain escape finds no way to run a string.
 *
 * Input on stdin: {"code": string, "inputs": string (JSON text), "timeoutMs": number}. Output on stdout: one JSON line {"ok": boolean, "result": string|null, "logs": string[], "error": string|null}.
 */
const vm = require("node:vm");

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

(async () => {
  let request;
  try {
    request = JSON.parse(await readStdin());
  } catch (e) {
    emit({ ok: false, result: null, logs: [], error: "bad_request" });
    return;
  }
  const timeoutMs = Math.max(100, Math.min(60000, Number(request.timeoutMs) || 10000));
  // from here on this process holds no way to reach the network from code that runs in the context; remove the one global that would
  try { delete globalThis.fetch; } catch (_) { /* ignore */ }

  const context = vm.createContext(
    { __inputs: String(request.inputs || "{}") },
    { name: "mission-sandbox", codeGeneration: { strings: false, wasm: false } },
  );
  const prelude = [
    "var __logs = [];",
    "var console = { log: function () { __logs.push(Array.prototype.map.call(arguments, function (a) { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); } }).join(' ').slice(0, 2000)); } };",
    "console.info = console.warn = console.error = console.log;",
    "var inputs = JSON.parse(__inputs);",
    "__inputs = undefined;",
  ].join("\n");
  try {
    vm.runInContext(prelude, context, { timeout: timeoutMs });
    const body = '"use strict";\n(function () {\n' + String(request.code) + "\n})()";
    const value = vm.runInContext(body, context, { timeout: timeoutMs });
    context.__value = value;
    const text = vm.runInContext(
      "(function () { var v = __value; if (v === undefined) return null; var s = JSON.stringify(v); return s === undefined ? null : s; })()",
      context,
      { timeout: timeoutMs },
    );
    const logs = vm.runInContext("JSON.stringify(__logs.slice(0, 200))", context, { timeout: timeoutMs });
    emit({ ok: true, result: typeof text === "string" ? text : null, logs: JSON.parse(logs), error: null });
  } catch (e) {
    let message = "error";
    try { message = String((e && e.message) || e).slice(0, 500); } catch (_) { /* keep default */ }
    emit({ ok: false, result: null, logs: [], error: message });
  }
})();
