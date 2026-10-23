import { facebookKeywordMissionReport, facebookKeywordMissionSensitivity, facebookTopicCostReport, MISSION_BASIS, MISSION_DEFAULT_INPUTS } from "../src/lib/costEstimate";

// Read-only: prints the cost estimates of the 300-post / 5-comments-per-post Facebook request. No call is made.
// `mission` is the one-item Facebook keyword service (catalog read of 2026-10-23); `twoServices` is the earlier two-service model, kept for comparison (its post price was an assumption the catalog did not confirm).
console.log(JSON.stringify({
  mission: { inputs: MISSION_DEFAULT_INPUTS, basis: MISSION_BASIS, report: facebookKeywordMissionReport(), sensitivity: facebookKeywordMissionSensitivity().map(({ rowsPerCall, relevance, report }) => ({ rowsPerCall, relevance, providerUsd: report.providerUsd, totalCostUsd: report.totalCostUsd, costPerCommentUsd: report.costPerCommentUsd, basisHolds: report.basisHolds, marginShare: report.marginShare })) },
  twoServices: facebookTopicCostReport(),
}, null, 2));
