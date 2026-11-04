import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HeaderBalance } from "../src/components/app/HeaderBalance";
import { balanceLoading, balanceReady, balanceFailed } from "../src/lib/honestDisplay";

describe("header balance", () => {
  it("shows a skeleton while loading, and never a zero in its place", () => {
    const html = renderToStaticMarkup(createElement(HeaderBalance, { balance: balanceLoading() }));
    expect(html).toContain('data-testid="balance-skeleton"');
    expect(html).not.toContain("٠");
  });
  it("shows the actual ready value and does not invent one on failure", () => {
    expect(renderToStaticMarkup(createElement(HeaderBalance, { balance: balanceReady(125) }))).toContain("١٢٥");
    expect(renderToStaticMarkup(createElement(HeaderBalance, { balance: balanceFailed() }))).not.toContain("٠");
  });
});
