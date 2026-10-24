import type { ReportState } from "../server/facebookReportAdapter";
import type { ReportPayload } from "./aggregate";

/** The saved form of a finished job (what `metadata.facebookReport` holds), built from the last chunk's record. */
export function payloadFromState(state: ReportState): ReportPayload {
  const browsed = state.pages.filter((page) => page.status !== "skipped" && page.calls > 0).length;
  const skippedPages = state.pages.filter((page) => page.status === "skipped").length;
  return {
    v: 1,
    request: { ...state.req },
    collection: {
      pagesMatching: state.pages.length + state.skippedRegistry.length,
      pagesUsable: state.pages.length,
      pagesBrowsed: browsed,
      pagesSkipped: skippedPages + state.skippedRegistry.length,
      postsFound: state.stats.seen,
      postsOutsideWindow: state.stats.outside,
      postsUndated: state.stats.undated,
      duplicates: state.duplicates,
      searchCalls: state.search.calls,
      searchPosts: state.search.kept,
      searchRejectedCountry: state.search.rejectedCountry,
      selectionDropped: state.selection?.dropped ?? 0,
      shareConfigured: state.selection?.share ?? 0.2,
      shareEffective: state.selection?.effective ?? 0.2,
      modelCalls: state.classify.modelCalls,
      modelBudgetStopped: state.classify.budgetStopped,
      modelFailed: state.classify.modelFailed,
      commentsEmpty: state.comments.empty,
      commentsDuplicates: state.comments.duplicates,
      commentsLinkOnly: state.comments.linkOnly,
      commentsNotReturned: state.comments.notReturned,
      stopped: state.comments.stopped,
    },
    posts: state.posts,
    pages: [
      ...state.pages.map((page) => {
        const stats = state.stats.perPage[page.id] ?? { seen: 0, kept: 0, outside: 0, undated: 0 };
        return { nameAr: page.nameAr, ...stats, end: page.end ?? null };
      }),
      ...state.skippedRegistry.map((entry) => ({ nameAr: entry.nameAr, seen: 0, kept: 0, outside: 0, undated: 0, end: entry.reason })),
    ],
  };
}
