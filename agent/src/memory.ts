import { readFileSync, readdirSync } from "node:fs";

/**
 * The memory the worker uses, in MB, for the heartbeat row. `rssMb` is this process (process.memoryUsage().rss). `treeRssMb` is this process plus every process it started
 * (the Claude Agent SDK runs a native process for each running mission, and the dyno's 512 MB counts them all): read from /proc on Linux, null elsewhere.
 * Pages are counted at 4096 bytes (the page size of a Heroku dyno).
 */
const PAGE_BYTES = 4096;
const MB = 1024 * 1024;

export interface MemoryReading { rssMb: number; treeRssMb: number | null }

export function processTreeRssMb(rootPid: number, procDir = "/proc"): number | null {
  try {
    const parent = new Map<number, number>();
    const rssPages = new Map<number, number>();
    for (const name of readdirSync(procDir)) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      try {
        // /proc/<pid>/stat: "pid (comm) state ppid ...": comm may hold spaces and parentheses, so cut after the LAST ")"
        const stat = readFileSync(`${procDir}/${pid}/stat`, "utf8");
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        parent.set(pid, Number(rest[1]));
        const statm = readFileSync(`${procDir}/${pid}/statm`, "utf8").split(" ");
        rssPages.set(pid, Number(statm[1]));
      } catch { /* the process ended while we read: skip it */ }
    }
    if (!rssPages.has(rootPid)) return null;
    const inTree = new Set<number>([rootPid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [pid, ppid] of parent) if (!inTree.has(pid) && inTree.has(ppid)) { inTree.add(pid); grew = true; }
    }
    let pages = 0;
    for (const pid of inTree) pages += rssPages.get(pid) ?? 0;
    return Math.round((pages * PAGE_BYTES) / MB);
  } catch {
    return null;
  }
}

export function readMemory(): MemoryReading {
  return { rssMb: Math.round(process.memoryUsage().rss / MB), treeRssMb: processTreeRssMb(process.pid) };
}
