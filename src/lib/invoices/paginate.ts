/**
 * A4 pagination from MEASURED heights (the browser measures each row with the real font; this function only decides where pages break).
 * Pure and deterministic, so it is tested with plain numbers. Rules:
 *  - a row is never split; a «keep with next» row (a batch heading) never ends a page alone;
 *  - the column header repeats on every page that has rows;
 *  - the tail blocks (totals, then notes + payment) are kept whole, in order, after the last row; one that does not fit starts a new page;
 *  - there is always at least one page.
 */
export interface PaginateInput {
  rowHeights: number[];
  keepWithNext: boolean[];
  /** usable height of a page body (between the repeated header and the footer) */
  pageBody: number;
  /** extra height page 1 spends above the table (document title, meta, parties) */
  firstPageReserve: number;
  /** height of the repeated column header */
  tableHead: number;
  /** heights of the blocks after the table, in order */
  tails: number[];
}

export interface PagePlan { rows: number[]; tails: number[] }

export function paginate(input: PaginateInput): PagePlan[] {
  const { rowHeights, keepWithNext, pageBody, firstPageReserve, tableHead, tails } = input;
  const n = rowHeights.length;
  const pages: PagePlan[] = [];
  let current: PagePlan = { rows: [], tails: [] };
  let remaining = pageBody - firstPageReserve - (n > 0 ? tableHead : 0);

  for (let i = 0; i < n; i++) {
    const h = rowHeights[i];
    const need = keepWithNext[i] && i + 1 < n ? h + rowHeights[i + 1] : h;
    if (need <= remaining || current.rows.length === 0) {
      current.rows.push(i);
      remaining -= h;
    } else {
      pages.push(current);
      current = { rows: [i], tails: [] };
      remaining = pageBody - tableHead - h;
    }
  }
  tails.forEach((h, t) => {
    if (h <= remaining || (current.rows.length === 0 && current.tails.length === 0 && pages.length === 0)) {
      current.tails.push(t);
      remaining -= h;
    } else {
      pages.push(current);
      current = { rows: [], tails: [t] };
      remaining = pageBody - h;
    }
  });
  pages.push(current);
  return pages;
}

/** «صفحة ١ من ٣» */
export function pageLabel(page: number, total: number, digits: (n: number) => string): string {
  return `صفحة ${digits(page)} من ${digits(total)}`;
}
