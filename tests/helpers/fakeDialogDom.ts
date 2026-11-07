/**
 * The suite runs in node (no DOM, no jsdom in the repo): a window is a few fake elements that implement only what the focus rules touch.
 * Shared by tests/overlay-escape-focus.test.tsx and tests/dialog-lifecycle.test.tsx.
 */
export class FakeDoc {
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

export class FakeEl {
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs = new Map<string, string>();
  tabIndex = 0;
  connected = true;
  constructor(public doc: FakeDoc, public name: string, public focusable = false) {}
  add(child: FakeEl) { child.parent = this; this.children.push(child); return child; }
  get isConnected() { return this.connected; }
  all(): FakeEl[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll() { return this.all().filter((el) => el.focusable); }
  getClientRects() { return [{}]; }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name) || (name === "tabindex" && this.tabIndex !== 0); }
  contains(other: FakeEl | null): boolean { return !!other && (other === this || this.all().includes(other)); }
  focus() { this.doc.activeElement = this; this.doc.fire("focusin", { target: this }); }
}

/** A window: a root with `buttons` focusable children. */
export function windowOf(doc: FakeDoc, name: string, buttons = 3) {
  const root = new FakeEl(doc, name);
  const items = Array.from({ length: buttons }, (_, i) => root.add(new FakeEl(doc, `${name}-${i}`, true)));
  return { root, items };
}
