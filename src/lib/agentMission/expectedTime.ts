import { formatAr } from "../arabicDigits";
import { estimateMissionMinutes } from "./price";

/**
 * THE EXPECTED TIME OF A MISSION IN WORDS: the one function the plan card and the public calculator both use (the minutes from `estimateMissionMinutes`, the words from `minutesAr`), so the same mission
 * never reads «أقل من دقيقة» in the calculator and «نحو دقيقتين» on its card.
 */
const hoursAr = (h: number): string => (h <= 1 ? "نحو ساعة" : h === 2 ? "نحو ساعتين" : `نحو ${formatAr(h)} ساعات`);

export const minutesAr = (m: number): string => (m <= 1 ? "نحو دقيقة" : m === 2 ? "نحو دقيقتين" : m <= 10 ? `نحو ${formatAr(m)} دقائق` : m < 60 ? `نحو ${formatAr(m)} دقيقة` : hoursAr(Math.ceil(m / 60)));

/** The minutes and the words for a mission of these stages (a calculator estimate is one stage of the records asked for). */
export function expectedTimeOf(stages: ReadonlyArray<{ rows: number; msPerRow?: number | null }>): { minutes: number; textAr: string } {
  const minutes = estimateMissionMinutes(stages);
  return { minutes, textAr: minutesAr(minutes) };
}
