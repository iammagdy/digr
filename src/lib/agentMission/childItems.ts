import { itemNounOf, GENERIC_ITEM_NOUN, knownItemNoun } from "./itemNoun";
import { normalizeText } from "./relevance";

/**
 * THE ITEMS OF A CHILD STAGE ARE RAW. Diger serves researchers who analyse data: the comments of a post, the replies, the reviews of a place and the employees of a company are delivered exactly as the source gives them, in the
 * source's order, up to the count asked (or all of them): no topic filter, no language filter, no place filter, no text de-duplication (two people who wrote the same comment wrote two comments; only the same item id is one item).
 * The relevance and the language rules choose the PARENTS (posts, videos, places, accounts) and the top-level items (tweets, posts by topic). The card says so in one plain sentence built here. Pure: no I/O.
 */
export const isChildStage = (stage: { parent_key: string | null }): boolean => stage.parent_key !== null;

/** The plural of an item noun as the subject of a passive sentence («تُجمع التعليقات», «يُجمع الموظفون»): the sound masculine plural takes «ون». */
const subjectPlural = (plural: string): string => (plural.endsWith("ين") ? `${plural.slice(0, -2)}ون` : plural);

/** One sentence per delivered child stage: «تُجمع التعليقات كما هي على كل فيديو، دون تصفية.» */
export function childRuleLinesAr(stages: ReadonlyArray<{ key: string; title_ar: string; parent_key: string | null; deliver: boolean }>): string[] {
  const lines: string[] = [];
  for (const s of stages) {
    if (!s.deliver || s.parent_key === null) continue;
    const parent = stages.find((p) => p.key === s.parent_key);
    const child = itemNounOf(s.title_ar);
    const parentNoun = parent ? itemNounOf(parent.title_ar) : GENERIC_ITEM_NOUN;
    const plural = subjectPlural(child.plural);
    lines.push(`تُجمع ال${plural} كما هي على كل ${parentNoun.singular}، دون تصفية.`);
  }
  return [...new Set(lines)];
}

/** True when the child's title carries one of the forms of the parent's noun, or the parent's noun is unknown. */
export function titleNamesParent(childTitle: string, parentTitle: string): boolean {
  const parentNoun = itemNounOf(parentTitle);
  if (parentNoun.key === GENERIC_ITEM_NOUN.key) return true;
  const words = normalizeText(childTitle).replace(/[«»"،,.:؛]/g, " ").split(/\s+/).filter(Boolean);
  return words.some((w) => knownItemNoun(w)?.key === parentNoun.key);
}

/**
 * The title of a child stage on the CARD says what it is and on what («تعليقات على فيديوهات عن الدوري المصري», not «التعليقات»): the model's own title when it already names the parent, else the title followed by «على» and the parent's plural,
 * built here (the title stored in the plan, the sheets and the file names are untouched).
 */
export function childCardTitleAr(stage: { title_ar: string; parent_key: string | null }, stages: ReadonlyArray<{ key: string; title_ar: string }>): string {
  if (stage.parent_key === null) return stage.title_ar;
  const parent = stages.find((p) => p.key === stage.parent_key);
  if (!parent || titleNamesParent(stage.title_ar, parent.title_ar)) return stage.title_ar;
  return `${stage.title_ar} على ${itemNounOf(parent.title_ar).plural}`;
}
