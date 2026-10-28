/**
 * What a stage found by a TEXT SEARCH must carry since relevance became part of the plan (src/lib/agentMission/relevance.ts): the rule that says what «matching» means, and `yield_from`, the run_code output that
 * holds the rows of the measured page. The fake pages of the older replays hold topic-shaped rows, so these helpers build the rule from the words every row carries.
 */
export const aboutWords = (terms: string[], extra: Record<string, unknown> = {}) => ({ subject_ar: "الموضوع الذي طلبته", terms, text_columns: ["text"], min_own_words: 0, ...extra });

/** The id of the first run_code output of a fake transcript (the rows of the measured page). */
export const firstOutputId = (results: Array<{ tool: string; result: Record<string, unknown> }>): string => String(results.filter((x) => x.tool === "run_code")[0]?.result.output_id);
