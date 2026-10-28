import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CallPhase } from "./types";

const here = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
export const SYSTEM_PROMPT_PATH = path.join(here, "..", "prompts", "system.md");

/** The system prompt of a phase: the common part of prompts/system.md plus that phase's section. The prompt lives in a file so the owner can read and change it. */
export function loadSystemPrompt(phase: CallPhase, file: string = SYSTEM_PROMPT_PATH): string {
  const text = readFileSync(file, "utf8");
  const [common, rest] = [text.split("<!--planning-->")[0], text.split("<!--planning-->")[1] ?? ""];
  const [planning, executionAndEnd] = [rest.split("<!--execution-->")[0], rest.split("<!--execution-->")[1] ?? ""];
  const execution = executionAndEnd.split("<!--end-->")[0];
  return `${common.trim()}\n\n${(phase === "planning" ? planning : execution).trim()}\n`;
}
