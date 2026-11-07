import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDialogCount, trapDialog } from "../src/hooks/useDialogA11y";
import { Drawer, Modal } from "../src/components/ui";
import { MissionPlanSheet } from "../src/components/mission/MissionPlanPanel";
import { FakeDoc, FakeEl, windowOf } from "./helpers/fakeDialogDom";

/** Every window a test opens is closed after it, so one test can never leave a trap (or a listener) behind for the next. */
const docs: FakeDoc[] = [];
const ends: Array<(end?: { restoreFocus?: boolean }) => void> = [];
const newDoc = () => { const doc = new FakeDoc(); docs.push(doc); return doc; };
const open = (doc: FakeDoc, root: FakeEl, options: { onClose?: () => void; initialFocus?: FakeEl; trapFocus?: boolean } = {}) => {
  const end = trapDialog(doc as unknown as Document, root as unknown as HTMLElement, { onClose: options.onClose ?? (() => {}), initialFocus: options.initialFocus as unknown as HTMLElement, trapFocus: options.trapFocus });
  ends.push(end);
  return end;
};
afterEach(() => {
  for (const end of ends.splice(0)) end();
  expect(openDialogCount(), "a window was left open by the test").toBe(0);
  for (const doc of docs.splice(0)) expect(doc.listenerCount(), "a listener was left on the document").toBe(0);
});

describe("a window over the page: Escape closes it, focus stays inside, focus goes back", () => {
  it("Escape calls onClose; after the window is closed Escape does nothing and no listener is left", () => {
    const doc = newDoc();
    const { root } = windowOf(doc, "w");
    const onClose = vi.fn();
    const end = open(doc, root, { onClose });
    expect(doc.key("Escape").stopped).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    end();
    doc.key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(doc.listenerCount()).toBe(0);
    expect(openDialogCount()).toBe(0);
  });

  it("ending a window twice is harmless (the second call neither throws nor moves focus again)", () => {
    const doc = newDoc();
    const opener = doc.body.add(new FakeEl(doc, "opener", true));
    opener.focus();
    const { root } = windowOf(doc, "w");
    const end = open(doc, root);
    end();
    expect(doc.activeElement).toBe(opener);
    const elsewhere = doc.body.add(new FakeEl(doc, "elsewhere", true));
    elsewhere.focus();
    end();
    expect(doc.activeElement).toBe(elsewhere);
  });

  it("focus moves to the first control on open (or to the one named), and returns to the opener on close", () => {
    const doc = newDoc();
    const opener = doc.body.add(new FakeEl(doc, "opener", true));
    opener.focus();
    const { root, items } = windowOf(doc, "w");
    const end = open(doc, root);
    expect(doc.activeElement).toBe(items[0]);
    end();
    expect(doc.activeElement).toBe(opener);

    const second = windowOf(doc, "c");
    const endSecond = open(doc, second.root, { initialFocus: second.items[2] });
    expect(doc.activeElement).toBe(second.items[2]);
    endSecond();
    expect(doc.activeElement).toBe(opener);
  });

  it("focus does not go back to an opener that is no longer on the page", () => {
    const doc = newDoc();
    const opener = doc.body.add(new FakeEl(doc, "opener", true));
    opener.focus();
    const { root, items } = windowOf(doc, "w");
    const end = open(doc, root);
    opener.connected = false;
    end();
    expect(doc.activeElement).toBe(items[0]);
  });

  it("Tab on the last control goes to the first, Shift+Tab on the first goes to the last, and the page behind never gets the key", () => {
    const doc = newDoc();
    const { root, items } = windowOf(doc, "w");
    open(doc, root);
    items[2].focus();
    expect(doc.key("Tab").prevented).toBe(true);
    expect(doc.activeElement).toBe(items[0]);
    expect(doc.key("Tab", true).prevented).toBe(true);
    expect(doc.activeElement).toBe(items[2]);
    items[1].focus();
    expect(doc.key("Tab").prevented).toBe(false); // in the middle the browser moves focus on its own
  });

  it("a window without any control keeps focus on itself", () => {
    const doc = newDoc();
    const { root } = windowOf(doc, "empty", 0);
    open(doc, root);
    expect(doc.activeElement).toBe(root);
    expect(doc.key("Tab").prevented).toBe(true);
    expect(doc.activeElement).toBe(root);
  });

  it("focus that lands behind the window (a click, a script) is brought back inside", () => {
    const doc = newDoc();
    const behind = doc.body.add(new FakeEl(doc, "behind", true));
    const { root, items } = windowOf(doc, "w");
    open(doc, root);
    behind.focus();
    expect(doc.activeElement).toBe(items[0]);
  });

  it("with two windows open, Escape and Tab belong to the top one only; closing it hands them back to the one below", () => {
    const doc = newDoc();
    const below = windowOf(doc, "below");
    const top = windowOf(doc, "top");
    const closeBelow = vi.fn();
    const closeTop = vi.fn();
    open(doc, below.root, { onClose: closeBelow });
    const endTop = open(doc, top.root, { onClose: closeTop });
    doc.key("Escape");
    expect(closeTop).toHaveBeenCalledTimes(1);
    expect(closeBelow).not.toHaveBeenCalled();
    // focus in the top window is not pulled back by the one below
    expect(top.root.contains(doc.activeElement)).toBe(true);
    endTop();
    doc.key("Escape");
    expect(closeBelow).toHaveBeenCalledTimes(1);
  });
});

describe("a window the page opened by itself (trapFocus: false) never takes focus from what the customer is typing", () => {
  it("focus is not moved in, Tab is not held, focus elsewhere is not pulled back, and nothing is restored on close", () => {
    const doc = newDoc();
    const composer = doc.body.add(new FakeEl(doc, "composer", true));
    composer.focus();
    const { root } = windowOf(doc, "auto-panel");
    const end = open(doc, root, { trapFocus: false });
    expect(doc.activeElement).toBe(composer);
    expect(doc.key("Tab").prevented).toBe(false);
    composer.focus();
    expect(doc.activeElement).toBe(composer);
    expect(root.hasAttribute("tabindex")).toBe(false);
    const elsewhere = doc.body.add(new FakeEl(doc, "elsewhere", true));
    elsewhere.focus();
    end();
    expect(doc.activeElement).toBe(elsewhere);
  });

  it("Escape still closes it", () => {
    const doc = newDoc();
    const { root } = windowOf(doc, "auto-panel");
    const onClose = vi.fn();
    open(doc, root, { trapFocus: false, onClose });
    expect(doc.key("Escape").stopped).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("when the customer opens it with a button (trapFocus: true) the same window does take focus and hold it", () => {
    const doc = newDoc();
    const opener = doc.body.add(new FakeEl(doc, "open-button", true));
    opener.focus();
    const { root, items } = windowOf(doc, "panel");
    const end = open(doc, root, { trapFocus: true });
    expect(doc.activeElement).toBe(items[0]);
    items[2].focus();
    expect(doc.key("Tab").prevented).toBe(true);
    end();
    expect(doc.activeElement).toBe(opener);
  });

  it("a window that does not trap does not take Tab away from a trapping window below it; Escape goes to the one on top", () => {
    const doc = newDoc();
    const below = windowOf(doc, "below");
    const closeBelow = vi.fn();
    const closeAuto = vi.fn();
    open(doc, below.root, { onClose: closeBelow });
    open(doc, windowOf(doc, "auto").root, { trapFocus: false, onClose: closeAuto });
    below.items[2].focus();
    expect(doc.key("Tab").prevented).toBe(true); // the lower window still holds focus
    expect(doc.activeElement).toBe(below.items[0]);
    doc.key("Escape");
    expect(closeAuto).toHaveBeenCalledTimes(1);
    expect(closeBelow).not.toHaveBeenCalled();
  });
});

describe("the windows of the app use it, and name themselves for a screen reader", () => {
  const idOf = (html: string, tag: RegExp) => /aria-labelledby="([^"]+)"/.exec(tag.exec(html)![0])![1];

  it("Modal and Drawer: role=dialog, aria-modal, aria-labelledby pointing at the visible title", () => {
    for (const element of [
      createElement(Modal, { open: true, onClose: () => {}, title: "تخصيص", children: "x" }),
      createElement(Drawer, { open: true, onClose: () => {}, title: "القائمة", children: "x" }),
    ]) {
      const html = renderToStaticMarkup(element);
      expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="[^"]+"/);
      const id = idOf(html, /<div[^>]*role="dialog"[^>]*>/);
      expect(html).toContain(`<h2 id="${id}"`);
    }
  });

  it("MissionPlanSheet: a dialog named by its heading", () => {
    const html = renderToStaticMarkup(createElement(MissionPlanSheet, { content: { title: "خطة المهمة", steps: [], live: false, startedAt: null } as any, onClose: () => {} }));
    expect(html).toMatch(/<section[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="[^"]+"/);
    const id = idOf(html, /<section[^>]*role="dialog"[^>]*>/);
    expect(html).toContain(`<h2 id="${id}"`);
  });

  it("the chat page gives the history drawer and the results sheet (below lg only) to the hook; the results sheet holds focus only when the customer opened it", () => {
    const chat = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(chat).toContain("useDialogA11y({ open: historyOpen, onClose: closeHistoryPanel, containerRef: historyRef })");
    expect(chat).toContain("useDialogA11y({ open: canvasOpen, enabled: belowLg, trapFocus: canvasOpenedByCustomer,");
    expect(chat).toMatch(/<aside ref=\{historyRef\} role="dialog" aria-modal="true" aria-labelledby="chat-history-title"/);
    expect(chat).toContain('role={belowLg ? "dialog" : "region"} aria-modal={belowLg && canvasOpenedByCustomer ? true : undefined}');
    // the three buttons that open the panel are the customer's; every other setCanvasOpen(true) is the page opening it by itself
    // (the first two keep their original onClick text; the mark is set in onClickCapture, which runs first on the same tap)
    expect(chat.match(/onClickCapture=\{\(\) => setCanvasOpenedByCustomer\(true\)\}/g)?.length).toBe(2);
    expect(chat).toContain("onOpenCanvas={() => { setCanvasOpenedByCustomer(true); setCanvasOpen((v) => !v); }}");
    expect(chat).toContain("useEffect(() => { if (!canvasOpen) setCanvasOpenedByCustomer(false); }, [canvasOpen]);");
  });

  it("the chat page renders the methodology confirmation through its own component, wired to the purchase state", () => {
    const chat = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(chat).toContain("<MethodologyConfirmDialog open={methodologyConfirmOpen} methodologyPurchasing={methodologyPurchasing}");
    expect(chat).toContain("confirmGenerateMethodology={confirmGenerateMethodology}");
  });
});
