/**
 * NOV 7 2026 (Facebook retest msn_365928deea447ca8ae92): A LINK IN A SAMPLE TABLE IS WHOLE OR IT IS NOT SHOWN.
 * The card's sample cells were cut at 120 characters, every cell alike. The first post's real permalink,
 * `https://www.facebook.com/permalink.php?story_fbid=pfbid02V4…Kl&id=61570030318692` (155 characters, exactly as the source returned it),
 * reached the customer as `…story_fbid=pfbid02V4…VPfT`: its `story_fbid` was cut and its `id` was gone, so the link the card showed opened nothing.
 * The file and the live sheet always held the whole link (they never cut a cell); only the preview did.
 *
 * Rules (pure, no I/O):
 *  - a cell that is a link (`http(s)://` and no space) is never cut: it is shown exactly as the source gave it, up to `SAMPLE_LINK_MAX_CHARS`;
 *  - a longer link is replaced by a sentence that says so (`LONG_LINK_NOTE_AR`): never a partial link that looks like a working one;
 *  - a public plan stored BEFORE this rule (its stage has no `links_whole` mark) may hold a link cut at exactly 120 characters: such a cell is not
 *    shown as a link, the card says it was cut in the preview (`CLIPPED_LINK_NOTE_AR`). Nothing is rebuilt: the missing part is not guessed.
 * Every other cell keeps its own limit.
 */

/** The longest link a sample cell shows whole (browsers and Excel accept links far shorter than this bound in practice). */
export const SAMPLE_LINK_MAX_CHARS = 2048;
/** The cut every sample cell got before NOV 7 2026: a stored link of exactly this length may be a cut one. */
export const LEGACY_SAMPLE_CELL_CHARS = 120;

export const LONG_LINK_NOTE_AR = "الرابط أطول من أن يُعرض هنا؛ يصلك كاملًا كما أعاده المصدر في الملف.";
export const CLIPPED_LINK_NOTE_AR = "الرابط مقتطع في هذه المعاينة فلا يعمل منها؛ يصلك كاملًا كما أعاده المصدر في الملف.";

const LINK_CELL = /^https?:\/\/\S+$/i;

/** True for a cell that is one link and nothing else. */
export const isLinkCell = (text: string): boolean => LINK_CELL.test(text.trim());

/** A sample cell as the card shows it: a link whole (or a sentence when it is too long to show), any other text cut at `maxChars`. */
export function sampleCellText(text: string, maxChars: number): string {
  if (isLinkCell(text)) {
    const link = text.trim();
    return link.length <= SAMPLE_LINK_MAX_CHARS ? link : LONG_LINK_NOTE_AR;
  }
  return text.slice(0, maxChars);
}

/**
 * A cell of a STORED public sample, read back for the card. `linksWhole`: the stage was written under the rule above. Without the mark, a link of exactly
 * `LEGACY_SAMPLE_CELL_CHARS` characters is treated as cut and replaced by the sentence; every other cell is returned unchanged.
 */
export function storedSampleCell(text: string, linksWhole: boolean): string {
  if (!linksWhole && isLinkCell(text) && text.trim().length === LEGACY_SAMPLE_CELL_CHARS) return CLIPPED_LINK_NOTE_AR;
  return text;
}
