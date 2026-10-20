/** The most jobs one driver tick resumes; the next tick picks up the rest. */
export const MAX_JOBS_PER_TICK = 5;
/** A job idle for longer than this is left to the daily watchdog (it refunds it); the driver stops pushing it. */
export const MAX_IDLE_MS = 25 * 60 * 1000;
/**
 * A job touched more recently than this is between two chunks of a healthy chain (the worker chains the next chunk itself), so the
 * driver leaves it alone instead of racing the chain. The claim lease would refuse the second runner anyway; this only saves calls.
 */
export const MIN_IDLE_MS = 15 * 1000;
/** One driver call must end inside the platform limit of 60 s: the worker's own deadline is 45 s, this leaves room to answer. */
export const DRIVER_DISPATCH_TIMEOUT_MS = 50_000;
