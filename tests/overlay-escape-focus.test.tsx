import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { trapDialog } from "../src/hooks/useDialogA11y";
import { Drawer, Modal } from "../src/components/ui";
import { MissionPlanSheet } from "../src/components/mission/MissionPlanPanel";

/* The suite runs in node (no DOM): a window is a few fake elements that implement only what the focus rules touch. */
class FakeDoc {
  activeElement: FakeEl | null = null;
  body = new FakeEl(this, "body");
  private listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(type: string, fn: (event: any) => void) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn); }
  removeEventListener(type: string, fn: (event: any) => void) { this.listeners.get(type)?.delete(fn); }
  fire(type: string, event: object) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event); }
  listenerCount() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
  key(key: string, shiftKey = false) {
    const event = { key, shiftKey, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    this.fire("keydown", event);
    return event;
  }
}
class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  tabIndex = 0;
  constructor(public doc: FakeDoc, public name: string, public focusable = false) {}
  add(child: FakeEl) { child.parent = this; this.children.push(child); return child; }
  get isConnected() { return true; }
  all(): FakeEl[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll() { return this.all().filter((el) => el.focusable); }
  getClientRects() { return [{}]; }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name) || name === "tabindex" && this.tabIndex !== 0; }
  contains(other: FakeEl | null): boolean { return !!other && (other === this || this.all().includes(other)); }
  focus() { this.doc.activeElement = this; this.doc.fire("focusin", { target: this }); }
}
function windowOf(doc: FakeDoc, name: string, buttons = 3) {
  const root = new FakeEl(doc, name);
  const items = Array.from({ length: buttons }, (_, i) => root.add(new FakeEl(doc, `${name}-${i}`, true)));
  return { root, items };
}
const open = (doc: FakeDoc, root: FakeEl, options: { onClose?: () => void; initialFocus?: FakeEl } = {}) =>
  trapDialog(doc as unknown as Document, root as unknown as HTMLElement, { onClose: options.onClose ?? (() => {}), initialFocus: options.initialFocus as unknown as HTMLElement });

describe("a window over the page: Escape closes it, focus stays inside, focus goes back", () => {
  it("Escape calls onClose; after the window is closed Escape does nothing and no listener is left", () => {
    const doc = new FakeDoc();
    const { root } = windowOf(doc, "w");
    const onClose = vi.fn();
    const end = open(doc, root, { onClose });
    expect(doc.key("Escape").stopped).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    end();
    doc.key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(doc.listenerCount()).toBe(0);
  });

  it("focus moves to the first control on open (or to the one named), and returns to the opener on close", () => {
    const doc = new FakeDoc();
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

  it("Tab on the last control goes to the first, Shift+Tab on the first goes to the last, and the page behind never gets the key", () => {
    const doc = new FakeDoc();
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
    const doc = new FakeDoc();
    const { root } = windowOf(doc, "empty", 0);
    open(doc, root);
    expect(doc.activeElement).toBe(root);
    expect(doc.key("Tab").prevented).toBe(true);
    expect(doc.activeElement).toBe(root);
  });

  it("focus that lands behind the window (a click, a script) is brought back inside", () => {
    const doc = new FakeDoc();
    const behind = doc.body.add(new FakeEl(doc, "behind", true));
    const { root, items } = windowOf(doc, "w");
    open(doc, root);
    behind.focus();
    expect(doc.activeElement).toBe(items[0]);
  });

  it("with two windows open, Escape and Tab belong to the top one only; closing it hands them back to the one below", () => {
    const doc = new FakeDoc();
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

  it("the chat page gives the history drawer, the results sheet (below lg only) and the methodology confirmation to the hook", () => {
    const chat = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(chat).toContain("useDialogA11y({ open: historyOpen, onClose: closeHistoryPanel, containerRef: historyRef })");
    expect(chat).toContain("useDialogA11y({ open: canvasOpen, enabled: belowLg,");
    expect(chat).toContain("useDialogA11y({ open: methodologyConfirmOpen,");
    expect(chat).toMatch(/<aside ref=\{historyRef\} role="dialog" aria-modal="true" aria-labelledby="chat-history-title"/);
    expect(chat).toContain('role={belowLg ? "dialog" : "region"} aria-modal={belowLg ? true : undefined}');
    // a purchase in progress is never cancelled by Escape
    expect(chat).toContain("if (!methodologyPurchasing) setMethodologyConfirmOpen(false)");
  });
});
