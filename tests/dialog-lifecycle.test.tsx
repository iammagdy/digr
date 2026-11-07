/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lifecycle of the hook (open, re-render, close, resize, unmount) and the methodology confirmation while a purchase is pending.
 * There is no DOM in the suite, so React's hooks are replaced by a small driver that follows the same rules (an effect runs again only when its
 * dependencies change, cleanups run before the new effects, unmount runs every cleanup) and the page is the fake elements of tests/helpers.
 * This proves the logic of the hook; it does not replace trying the windows in a real browser.
 */
const rt = vi.hoisted(() => ({ current: null as any }));
vi.mock("react", async (importOriginal) => {
  const actual: any = await importOriginal();
  const slot = () => {
    const inst = rt.current;
    if (!inst) throw new Error("a hook was called outside a render");
    return [inst, inst.i++] as const;
  };
  return {
    ...actual,
    default: actual.default ?? actual,
    useRef: (initial: unknown) => { const [inst, i] = slot(); return (inst.slots[i] ??= { current: initial }); },
    useState: (initial: unknown) => {
      const [inst, i] = slot();
      const s = (inst.slots[i] ??= { value: typeof initial === "function" ? (initial as () => unknown)() : initial });
      return [s.value, (value: unknown) => { s.value = value; }];
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const [inst, i] = slot();
      const s = inst.slots[i];
      const changed = !s || !deps || !s.deps || deps.length !== s.deps.length || deps.some((d, k) => !Object.is(d, s.deps[k]));
      if (!s) inst.slots[i] = { deps: undefined, cleanup: undefined };
      if (changed) inst.effects.push({ i, fn, deps });
    },
  };
});

import { openDialogCount, useDialogA11y } from "../src/hooks/useDialogA11y";
import MethodologyConfirmDialog from "../src/app/dashboard/chat/components/MethodologyConfirmDialog";
import { FakeDoc, FakeEl, windowOf } from "./helpers/fakeDialogDom";

interface Inst { comp: (props: any) => any; slots: any[]; i: number; effects: any[]; out: any; attach?: (out: any) => void; gone: boolean }
const mounted: Inst[] = [];
let doc: FakeDoc;

function commit(inst: Inst, props: any) {
  rt.current = inst;
  inst.i = 0;
  inst.effects = [];
  try { inst.out = inst.comp(props); } finally { rt.current = null; }
  inst.attach?.(inst.out); // React sets the refs after the render and before the effects run
  for (const e of inst.effects) { inst.slots[e.i].cleanup?.(); inst.slots[e.i].cleanup = undefined; }
  for (const e of inst.effects) { inst.slots[e.i].deps = e.deps; const cleanup = e.fn(); inst.slots[e.i].cleanup = typeof cleanup === "function" ? cleanup : undefined; }
  return inst.out;
}
function mount(comp: (props: any) => any, props: any, attach?: (out: any) => void): Inst {
  const inst: Inst = { comp, slots: [], i: 0, effects: [], out: null, attach, gone: false };
  mounted.push(inst);
  commit(inst, props);
  return inst;
}
function unmount(inst: Inst) {
  if (inst.gone) return;
  inst.gone = true;
  for (const s of inst.slots) if (s?.cleanup) { s.cleanup(); s.cleanup = undefined; }
}

beforeEach(() => {
  doc = new FakeDoc();
  (globalThis as any).document = doc;
});
afterEach(() => {
  for (const inst of mounted.splice(0)) unmount(inst);
  expect(openDialogCount(), "a window was left open").toBe(0);
  expect(doc.listenerCount(), "a listener was left on the document").toBe(0);
  delete (globalThis as any).document;
});

/** A window driven by the hook, with a stable ref like the page's own. */
function Win(props: { ref: { current: FakeEl }; open: boolean; enabled?: boolean; trapFocus?: boolean; onClose: () => void }) {
  useDialogA11y({ open: props.open, enabled: props.enabled, trapFocus: props.trapFocus, onClose: props.onClose, containerRef: props.ref as any });
  return null;
}
const win = (root: FakeEl, extra: Record<string, unknown> = {}) => ({ ref: { current: root }, open: true, onClose: vi.fn(), ...extra });

describe("two windows open together", () => {
  it("closed top first: Escape follows the stack, and focus goes back to where it started", () => {
    const start = doc.body.add(new FakeEl(doc, "start", true));
    start.focus();
    const a = windowOf(doc, "a");
    const b = windowOf(doc, "b");
    const pa = win(a.root);
    const pb = win(b.root);
    const ia = mount(Win, pa);
    const ib = mount(Win, pb);
    expect(openDialogCount()).toBe(2);
    doc.key("Escape");
    expect(pb.onClose).toHaveBeenCalledTimes(1);
    expect(pa.onClose).not.toHaveBeenCalled();
    commit(ib, { ...pb, open: false });
    expect(openDialogCount()).toBe(1);
    doc.key("Escape");
    expect(pa.onClose).toHaveBeenCalledTimes(1);
    commit(ia, { ...pa, open: false });
    expect(openDialogCount()).toBe(0);
    expect(doc.listenerCount()).toBe(0);
    expect(a.root.contains(doc.activeElement) || b.root.contains(doc.activeElement)).toBe(false);
  });

  it("closed in the opposite order: the one on top keeps Escape and Tab, and focus is not taken from it", () => {
    const a = windowOf(doc, "a");
    const b = windowOf(doc, "b");
    const pa = win(a.root);
    const pb = win(b.root);
    const ia = mount(Win, pa);
    const ib = mount(Win, pb);
    expect(b.root.contains(doc.activeElement)).toBe(true);
    // the lower window is closed (and leaves the page) while the upper one is still open
    a.items.forEach((el) => { el.connected = false; });
    commit(ia, { ...pa, open: false });
    expect(openDialogCount()).toBe(1);
    expect(b.root.contains(doc.activeElement), "closing the lower window moved focus out of the upper one").toBe(true);
    b.items[2].focus();
    expect(doc.key("Tab").prevented).toBe(true);
    doc.key("Escape");
    expect(pb.onClose).toHaveBeenCalledTimes(1);
    expect(pa.onClose).not.toHaveBeenCalled();
    commit(ib, { ...pb, open: false });
    expect(openDialogCount()).toBe(0);
    expect(doc.listenerCount()).toBe(0);
  });
});

describe("a window that is removed from the page without being closed", () => {
  it("unmount removes its listeners and its place in the stack, and focus goes back to the opener", () => {
    const opener = doc.body.add(new FakeEl(doc, "opener", true));
    opener.focus();
    const w = windowOf(doc, "w");
    const p = win(w.root);
    const inst = mount(Win, p);
    expect(openDialogCount()).toBe(1);
    expect(doc.activeElement).toBe(w.items[0]);
    unmount(inst);
    expect(openDialogCount()).toBe(0);
    expect(doc.listenerCount()).toBe(0);
    expect(doc.activeElement).toBe(opener);
    doc.key("Escape");
    expect(p.onClose).not.toHaveBeenCalled();
  });

  it("unmounting the lower of two windows leaves the upper one working", () => {
    const a = windowOf(doc, "a");
    const b = windowOf(doc, "b");
    const ia = mount(Win, win(a.root));
    const pb = win(b.root);
    mount(Win, pb);
    unmount(ia);
    expect(openDialogCount()).toBe(1);
    doc.key("Escape");
    expect(pb.onClose).toHaveBeenCalledTimes(1);
  });

  it("a window that is not open registers nothing, and opens cleanly later", () => {
    const w = windowOf(doc, "w");
    const p = win(w.root, { open: false });
    const inst = mount(Win, p);
    expect(openDialogCount()).toBe(0);
    expect(doc.listenerCount()).toBe(0);
    commit(inst, { ...p, open: true });
    expect(openDialogCount()).toBe(1);
    commit(inst, { ...p, open: false });
    expect(openDialogCount()).toBe(0);
  });
});

describe("the screen changes size while the window is open (phone to desktop and back)", () => {
  it("becoming a side column ends the trap, leaves focus where it is and stops Escape; becoming a sheet again holds focus again", () => {
    const opener = doc.body.add(new FakeEl(doc, "opener", true));
    opener.focus();
    const w = windowOf(doc, "sheet");
    const p = win(w.root, { enabled: true });
    const inst = mount(Win, p);
    w.items[1].focus();
    commit(inst, { ...p, enabled: false });
    expect(openDialogCount()).toBe(0);
    expect(doc.listenerCount()).toBe(0);
    expect(doc.activeElement, "focus was taken from the panel when the screen grew").toBe(w.items[1]);
    doc.key("Escape");
    expect(p.onClose).not.toHaveBeenCalled();
    commit(inst, { ...p, enabled: true });
    expect(openDialogCount()).toBe(1);
    expect(doc.listenerCount()).toBeGreaterThan(0);
    doc.key("Escape");
    expect(p.onClose).toHaveBeenCalledTimes(1);
    commit(inst, { ...p, open: false });
    expect(openDialogCount()).toBe(0);
    expect(doc.listenerCount()).toBe(0);
  });

  it("closing it on the wide layout restores nothing and leaves no listener", () => {
    const opener = doc.body.add(new FakeEl(doc, "opener", true));
    opener.focus();
    const w = windowOf(doc, "sheet");
    const p = win(w.root, { enabled: false });
    const inst = mount(Win, p);
    expect(doc.activeElement).toBe(opener);
    expect(openDialogCount()).toBe(0);
    commit(inst, { ...p, open: false });
    expect(doc.activeElement).toBe(opener);
    expect(doc.listenerCount()).toBe(0);
  });
});

describe("a window the page opened by itself, then opened by the customer", () => {
  it("opens without taking focus; a tap on its button then holds focus in it; closing returns focus to where the customer was", () => {
    const composer = doc.body.add(new FakeEl(doc, "composer", true));
    composer.focus();
    const w = windowOf(doc, "results");
    const p = win(w.root, { trapFocus: false });
    const inst = mount(Win, p);
    expect(doc.activeElement).toBe(composer);
    expect(doc.key("Tab").prevented).toBe(false);
    expect(openDialogCount()).toBe(1);
    commit(inst, { ...p, trapFocus: true });
    expect(doc.activeElement).toBe(w.items[0]);
    expect(openDialogCount()).toBe(1);
    w.items[2].focus();
    expect(doc.key("Tab").prevented).toBe(true);
    commit(inst, { ...p, trapFocus: true, open: false });
    expect(doc.activeElement).toBe(composer);
    expect(openDialogCount()).toBe(0);
  });

  it("an automatic open that is closed by Escape leaves the customer's focus alone", () => {
    const composer = doc.body.add(new FakeEl(doc, "composer", true));
    composer.focus();
    const w = windowOf(doc, "results");
    const p = win(w.root, { trapFocus: false });
    const inst = mount(Win, p);
    doc.key("Escape");
    expect(p.onClose).toHaveBeenCalledTimes(1);
    commit(inst, { ...p, trapFocus: false, open: false });
    expect(doc.activeElement).toBe(composer);
  });
});

describe("re-rendering an open window", () => {
  it("does not throw focus back to the first control, and Escape calls the latest onClose", () => {
    const w = windowOf(doc, "w");
    const first = win(w.root);
    const inst = mount(Win, first);
    w.items[2].focus();
    const latest = vi.fn();
    commit(inst, { ...first, onClose: latest });
    commit(inst, { ...first, onClose: latest });
    expect(doc.activeElement).toBe(w.items[2]);
    doc.key("Escape");
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first.onClose).not.toHaveBeenCalled();
    expect(openDialogCount()).toBe(1);
  });
});

describe("the methodology confirmation while a purchase is pending (mocked: nothing is bought)", () => {
  const walk = (node: any, visit: (el: any) => void) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return; }
    if (node.props) { visit(node); walk(node.props.children, visit); }
  };
  const find = (out: any, test: (el: any) => boolean) => { let found: any; walk(out, (el) => { if (!found && test(el)) found = el; }); return found; };
  const textOf = (el: any): string => (typeof el.props.children === "string" ? el.props.children : "");

  function setup() {
    const root = new FakeEl(doc, "dialog");
    const confirmEl = root.add(new FakeEl(doc, "confirm", true));
    const cancelEl = root.add(new FakeEl(doc, "cancel", true));
    const state = { open: true, purchasing: false };
    const onCancel = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inst!: Inst;
    const propsNow = () => ({ open: state.open, methodologyPurchasing: state.purchasing, pointsText: "٥٠ نقطة", confirmGenerateMethodology, onCancel });
    // the page's purchase: marks itself pending, waits for the (mocked) server, then clears the mark and closes
    const confirmGenerateMethodology = vi.fn(async () => {
      state.purchasing = true;
      commit(inst, propsNow());
      await gate;
      state.purchasing = false;
      state.open = false;
      commit(inst, propsNow());
    });
    const attach = (out: any) => {
      if (!out) return;
      const section = find(out, (el) => el.type === "section");
      const cancel = find(out, (el) => el.type === "button" && el.props.ref);
      const [confirm] = [find(out, (el) => el.type === "button" && !el.props.ref)];
      section.props.ref.current = root;
      cancel.props.ref.current = cancelEl;
      confirmEl.focusable = !confirm.props.disabled;
      cancelEl.focusable = !cancel.props.disabled;
    };
    inst = mount(MethodologyConfirmDialog as any, propsNow(), attach);
    const buttons = () => ({
      confirm: find(inst.out, (el) => el.type === "button" && !el.props.ref),
      cancel: find(inst.out, (el) => el.type === "button" && el.props.ref),
    });
    return { state, onCancel, release, inst, root, cancelEl, confirmGenerateMethodology, buttons };
  }

  it("with no purchase running: focus starts on «إلغاء», Escape and a click on the backdrop close it, a click inside does not", () => {
    const s = setup();
    expect(doc.activeElement).toBe(s.cancelEl);
    expect(s.buttons().confirm.props.disabled).toBe(false);
    expect(s.buttons().cancel.props.disabled).toBe(false);
    doc.key("Escape");
    expect(s.onCancel).toHaveBeenCalledTimes(1);
    const backdrop = s.inst.out;
    backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop });
    expect(s.onCancel).toHaveBeenCalledTimes(2);
    backdrop.props.onMouseDown({ target: s.root, currentTarget: backdrop });
    expect(s.onCancel).toHaveBeenCalledTimes(2);
  });

  it("while the purchase is pending: Escape and the backdrop do not close it, both buttons are disabled and Tab stays put; when it ends it closes and leaves no listener", async () => {
    const s = setup();
    s.buttons().confirm.props.onClick();
    expect(s.confirmGenerateMethodology).toHaveBeenCalledTimes(1);
    expect(s.state.purchasing).toBe(true);

    const { confirm, cancel } = s.buttons();
    expect(confirm.props.disabled).toBe(true);
    expect(cancel.props.disabled).toBe(true);
    expect(textOf(confirm)).toBe("جارٍ التجهيز…");

    doc.key("Escape");
    const backdrop = s.inst.out;
    backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop });
    expect(s.onCancel).not.toHaveBeenCalled();
    expect(s.inst.out, "the dialog closed under a running purchase").not.toBeNull();

    // both buttons are disabled, so Tab has nowhere to go: it must not leave the dialog
    expect(doc.key("Tab").prevented).toBe(true);
    expect(s.root.contains(doc.activeElement) || doc.activeElement === s.root).toBe(true);

    // the (mocked) server answers: the page clears the mark and closes the dialog
    s.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.inst.out).toBeNull();
    expect(openDialogCount()).toBe(0);
    expect(doc.listenerCount()).toBe(0);
    expect(s.onCancel).not.toHaveBeenCalled();
  });

  it("Escape works again once the purchase is no longer pending (a refused purchase keeps the dialog open)", () => {
    const s = setup();
    s.state.purchasing = true;
    commit(s.inst, { open: true, methodologyPurchasing: true, pointsText: "٥٠ نقطة", confirmGenerateMethodology: s.confirmGenerateMethodology, onCancel: s.onCancel });
    doc.key("Escape");
    expect(s.onCancel).not.toHaveBeenCalled();
    s.state.purchasing = false;
    commit(s.inst, { open: true, methodologyPurchasing: false, pointsText: "٥٠ نقطة", confirmGenerateMethodology: s.confirmGenerateMethodology, onCancel: s.onCancel });
    doc.key("Escape");
    expect(s.onCancel).toHaveBeenCalledTimes(1);
  });
});
