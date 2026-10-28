import type { TrackerEventInput } from "../../src/lib/agentMission/tracker";

/**
 * THE EVENTS OF THE LIVE RUN of 2026-10-28 («هات ٣٠٠ تغريدة عن محمد صلاح», msn_0a9ebe1b55e4bfb65ef6), read back from the mission_events table: the same times (UTC), the same counts, the same shapes. The source was read four times from its
 * first page (20, 15, 15 and 10 pages), and the rows were saved in lumps (151, 192, 193, 250, 300): the panel showed «٠ من ٣٠٠» for the first minute and a time left that jumped 28 → 2 → 4 → 2 → 7 → 11 minutes.
 */
const t = (clock: string) => `2026-10-28T${clock}Z`;
const stream = (planned: number, clocks: string[]): Array<[string, Record<string, number>]> => clocks.map((c, i) => [c, { pages: i + 1, rows: (i + 1) * 20, planned }]);
const saved = (clock: string, n: number): [string, Record<string, number>] => [clock, { stage: 1, saved: n, planned: 300 }];

const RAW: Array<[string, Record<string, number>]> = [
  ...stream(400, ["20:07:06.4", "20:07:09.2", "20:07:12.0", "20:07:15.8", "20:07:19.1", "20:07:21.8", "20:07:24.4", "20:07:26.6", "20:07:29.9", "20:07:33.2", "20:07:35.9", "20:07:38.5", "20:07:42.0", "20:07:44.6", "20:07:47.6", "20:07:50.0", "20:07:52.8", "20:07:55.6", "20:08:00.4", "20:08:02.7"]),
  saved("20:08:21.6", 151), saved("20:08:36.0", 192),
  ...stream(300, ["20:08:47.0", "20:08:50.8", "20:08:53.9", "20:08:56.5", "20:09:00.5", "20:09:03.5", "20:09:06.8", "20:09:13.6", "20:09:16.7", "20:09:19.5", "20:09:22.2", "20:09:24.7", "20:09:28.3", "20:09:30.9", "20:09:33.6"]),
  saved("20:09:39.9", 193),
  ...stream(300, ["20:09:52.6", "20:09:55.6", "20:09:59.0", "20:10:02.7", "20:10:07.0", "20:10:10.4", "20:10:13.4", "20:10:16.7", "20:10:19.8", "20:10:23.9", "20:10:27.0", "20:10:29.8", "20:10:33.5", "20:10:37.0", "20:10:40.5"]),
  saved("20:10:52.2", 250),
  ...stream(300, ["20:11:03.0", "20:11:06.1", "20:11:09.6", "20:11:13.4", "20:11:17.0", "20:11:20.2", "20:11:31.1", "20:11:34.6", "20:11:39.1", "20:11:42.4"]),
  saved("20:11:47.4", 300),
];

export const LIVE_RUN_EVENTS: TrackerEventInput[] = RAW.map(([clock, counts], i) => ({ id: i + 1, counts, created_at: t(clock.length === 10 ? clock : `${clock}`) }));
export const LIVE_RUN_STAGES = [{ n: 1, titleAr: "التغريدات التي تذكر محمد صلاح", expectedRows: 300, deliver: true }];
export const LIVE_RUN_START = Date.parse("2026-10-28T20:07:06.4Z");
export const LIVE_RUN_END = Date.parse("2026-10-28T20:11:47.4Z");
