/**
 * What the browser remembers from the server's status answer: whether the service runs at reduced capacity (see degradedMode.ts), and so
 * how much longer every optional wait is. Module state: shared by every poller of the page, reset by the next status answer.
 */
import { DEGRADED_SLOW_FACTOR } from "./degradedMode";

let slow = 1;

export function setDegradedFromServer(degraded: boolean): void {
  slow = degraded ? DEGRADED_SLOW_FACTOR : 1;
}

/** 1 normally, 3 while degraded. */
export function getSlowFactor(): number {
  return slow;
}
