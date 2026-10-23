/**
 * The most records one Facebook job holds: page posts, and the comments of those posts. ONE place: the two services in `socialSources.ts` read it, and so does the
 * plan fit (`planFit.facebookCeilings`, through the capability table). Raised from 60 posts / 500 comments for the owner's request of 300 posts with about 5 comments each.
 *
 * A job reads a page's posts page by page and stops by itself when the source repeats itself (`source_repeats` in providerCallCaps), when a run of pages brings nothing new, or when
 * the page caps bind; so a ceiling above what a source can really serve costs nothing but the pages it tried. Whether a real page serves 300 posts is NOT PROVEN (a page of the
 * owner's own test returned the same 3 posts on its second and third read).
 */
export const FACEBOOK_JOB_CEILINGS = { posts: 300, comments: 1500 } as const;
