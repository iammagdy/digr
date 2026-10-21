/**
 * CPU meter for the capacity model. Measures the CPU time (user + system, from process.cpuUsage) a piece of work takes, after warm-up
 * runs, and returns the median of several runs so one garbage collection does not decide. The numbers are RELATIVE (the same machine
 * runs every route, handlers only, in-memory fakes): scripts/capacity/cpuModel.ts calibrates them to the hosting plan's average.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CpuSample { name: string; runs: number; medianMs: number; p90Ms: number; meanMs: number }

const cpuMs = (usage: NodeJS.CpuUsage) => (usage.user + usage.system) / 1000;

export async function measureCpu(name: string, work: () => Promise<unknown>, options: { runs?: number; warmup?: number } = {}): Promise<CpuSample> {
  const runs = options.runs ?? 20;
  for (let i = 0; i < (options.warmup ?? 3); i += 1) await work();
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const before = process.cpuUsage();
    await work();
    samples.push(cpuMs(process.cpuUsage(before)));
  }
  samples.sort((a, b) => a - b);
  const at = (p: number) => samples[Math.min(samples.length - 1, Math.max(0, Math.ceil((p / 100) * samples.length) - 1))];
  return { name, runs, medianMs: round(at(50)), p90Ms: round(at(90)), meanMs: round(samples.reduce((a, b) => a + b, 0) / samples.length) };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Adds the samples to the JSON file (created when missing), keyed by name, so several test files can fill one measurements file. */
export function recordSamples(path: string | undefined, samples: CpuSample[], extra: Record<string, unknown> = {}): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { samples: {}, extra: {} };
  for (const sample of samples) current.samples[sample.name] = sample;
  current.extra = { ...current.extra, ...extra };
  writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
}
