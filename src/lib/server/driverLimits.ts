/** The most jobs one driver tick resumes; the next tick picks up the rest. */
export const MAX_JOBS_PER_TICK = 5;
/** A job idle for longer than this is left to the daily watchdog (it refunds it). */
export const MAX_IDLE_MS = 25 * 60 * 1000;
