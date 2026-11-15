import { emptyReviewState, type Reviewer } from "../../agent/src/review";

/**
 * P0 (15 Nov 2026): EVERY compiled plan of a research topic carries the execution's research gate (`relevance.judge = "model"`): a row is delivered only when the model review says it is about the request, and with no reviewer nothing of it
 * is delivered. The replays of real missions test OTHER things (comments, replies, dates, files, the delivery contract) on rows the live runs delivered, so they run with this reviewer standing in for the production model's «yes».
 * It is a stated assumption of those replays, never evidence of relevance: the gate itself is tested in tests/p0-research-relevance-cd5f.test.ts.
 */
export function approvingResearchReviewer(): Reviewer {
  const state = emptyReviewState();
  return {
    budgetUsd: 1,
    state: async () => state,
    review: async ({ rows }) => { state.rowsReviewed += rows.length; state.rowsAccepted += rows.length; return new Map(rows.map((r) => [r.id, true])); },
  };
}
