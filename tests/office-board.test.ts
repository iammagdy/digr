import fs, { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { buildOfficeFeed } from "../scripts/office-feed-updater.mjs";

class MockElement {
  tagName: string;
  id: string = "";
  className: string = "";
  style: Record<string, string> = {};
  _textContent: string = "";
  children: MockElement[] = [];
  listeners: Record<string, Function[]> = {};
  onclick: Function | null = null;
  attributes: Record<string, string> = {};
  parentElement: MockElement | null = null;
  offsetWidth: number = 268;
  offsetHeight: number = 220;
  clientWidth: number = 800;
  clientHeight: number = 540;
  hidden: boolean = false;
  src: string = "";
  type: string = "";

  constructor(tagName: string, id: string = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
  }

  get textContent(): string {
    if (this.children.length === 0) return this._textContent;
    return this.children.map((c) => c.textContent).join(" ");
  }

  set textContent(val: string) {
    this._textContent = val;
    this.children = [];
  }

  get classList() {
    return {
      add: (...classes: string[]) => {
        const cur = new Set(this.className.split(" ").filter(Boolean));
        for (const c of classes) cur.add(c);
        this.className = Array.from(cur).join(" ");
      },
      remove: (...classes: string[]) => {
        const cur = new Set(this.className.split(" ").filter(Boolean));
        for (const c of classes) cur.delete(c);
        this.className = Array.from(cur).join(" ");
      },
      toggle: (c: string, force?: boolean) => {
        const cur = new Set(this.className.split(" ").filter(Boolean));
        const shouldAdd = force !== undefined ? force : !cur.has(c);
        if (shouldAdd) cur.add(c);
        else cur.delete(c);
        this.className = Array.from(cur).join(" ");
        return shouldAdd;
      },
      contains: (c: string) => this.className.split(" ").includes(c),
    };
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  appendChild(child: MockElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: MockElement) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      child.parentElement = null;
      this.children.splice(idx, 1);
    }
    return child;
  }

  setAttribute(name: string, val: string) {
    this.attributes[name] = val;
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  contains(el: any): boolean {
    if (el === this) return true;
    for (const c of this.children) {
      if (c === el || (c.contains && c.contains(el))) return true;
    }
    return false;
  }

  addEventListener(evt: string, cb: Function) {
    if (!this.listeners[evt]) this.listeners[evt] = [];
    this.listeners[evt].push(cb);
  }

  trigger(evt: string, data: any = {}) {
    if (evt === "click" && this.onclick) {
      this.onclick(data);
    }
    const handlers = this.listeners[evt] || [];
    for (const h of handlers) h(data);
  }

  querySelector(sel: string): MockElement | null {
    const check = (el: MockElement): MockElement | null => {
      if (sel.startsWith(".")) {
        const classes = sel.slice(1).split(".").filter(Boolean);
        const elClasses = el.className.split(" ").filter(Boolean);
        if (classes.every((c) => elClasses.includes(c))) return el;
      }
      if (sel.startsWith("#") && el.id === sel.slice(1)) return el;
      if (el.tagName.toLowerCase() === sel.toLowerCase()) return el;
      for (const c of el.children) {
        const res = check(c);
        if (res) return res;
      }
      return null;
    };
    return check(this);
  }

  querySelectorAll(sel: string): MockElement[] {
    const list: MockElement[] = [];
    const check = (el: MockElement) => {
      if (sel.startsWith(".")) {
        const classes = sel.slice(1).split(".").filter(Boolean);
        const elClasses = el.className.split(" ").filter(Boolean);
        if (classes.every((c) => elClasses.includes(c))) list.push(el);
      } else if (sel.startsWith("#") && el.id === sel.slice(1)) {
        list.push(el);
      } else if (el.tagName.toLowerCase() === sel.toLowerCase()) {
        list.push(el);
      }
      for (const c of el.children) check(c);
    };
    for (const c of this.children) check(c);
    return list;
  }

  closest(sel: string): MockElement | null {
    if (sel.startsWith(".") && this.className.split(" ").includes(sel.slice(1))) return this;
    if (sel.startsWith("#") && this.id === sel.slice(1)) return this;
    if (this.tagName.toLowerCase() === sel.toLowerCase()) return this;
    return this.parentElement ? this.parentElement.closest(sel) : null;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 540 };
  }

  getContext() {
    return mockCtx;
  }
}

let mockCtx: any;

function createBoardHarness() {
  const html = readFileSync("public/office/index.html", "utf8");
  const script = html.split("<script>")[1].split("</script>")[0];

  const fillTextCalls: Array<{
    text: string;
    x: number;
    y: number;
    textAlign: string;
    fillStyle: string;
    direction: string;
  }> = [];

  const fetchCalls: any[] = [];
  const windowListeners: Record<string, Function[]> = {};

  mockCtx = {
    direction: "inherit",
    textAlign: "start",
    fillStyle: "#000000",
    font: 'bold 7.5px "IBM Plex Sans Arabic", Tahoma, sans-serif',
    save() {},
    restore() {},
    setTransform() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    rect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arcTo() {},
    closePath() {},
    arc() {},
    ellipse() {},
    fill() {},
    stroke() {},
    setLineDash() {},
    measureText(text: string) {
      return { width: Array.from(text).length * 5.5 };
    },
    fillText(text: string, x: number, y: number) {
      fillTextCalls.push({
        text,
        x,
        y,
        textAlign: mockCtx.textAlign,
        fillStyle: mockCtx.fillStyle,
        direction: mockCtx.direction,
      });
    },
    drawImage() {},
    clip() {},
    translate() {},
    scale() {},
    createRadialGradient() {
      return { addColorStop() {} };
    },
  };

  const elements = new Map<string, MockElement>();
  const stageWrapper = new MockElement("div", "stage-wrapper");
  const canvasEl = new MockElement("canvas", "office-canvas");
  elements.set("stage-wrapper", stageWrapper);
  elements.set("office-canvas", canvasEl);
  stageWrapper.appendChild(canvasEl);

  const extraIds = [
    "feed-dot", "feed-meta", "log-drawer", "log-list", "log-close",
    "demo-banner", "hint-pill", "brand-status", "room-nav",
    "side-rail-right", "side-rail-left"
  ];
  for (const id of extraIds) {
    const el = new MockElement("div", id);
    elements.set(id, el);
    stageWrapper.appendChild(el);
  }

  // Pre-create manager menu & controls for querySelectorAll
  const mgrMenu = new MockElement("div");
  mgrMenu.className = "manager-menu";
  const mgrBtn = new MockElement("button");
  mgrBtn.className = "stage-control-btn manager-menu-btn";
  const mgrList = new MockElement("div");
  mgrList.className = "manager-menu-list";
  const meetingBtn = new MockElement("button");
  meetingBtn.className = "manager-menu-item meeting-btn";
  const bossBtn = new MockElement("button");
  bossBtn.className = "manager-menu-item boss-btn";
  const pizzaBtn = new MockElement("button");
  pizzaBtn.className = "manager-menu-item pizza-btn";
  const demoBtn = new MockElement("button");
  demoBtn.className = "manager-menu-item demo-btn";
  mgrList.appendChild(meetingBtn);
  mgrList.appendChild(bossBtn);
  mgrList.appendChild(pizzaBtn);
  mgrList.appendChild(demoBtn);
  mgrMenu.appendChild(mgrBtn);
  mgrMenu.appendChild(mgrList);
  stageWrapper.appendChild(mgrMenu);

  for (const kpi of ["kpi-work", "kpi-stuck", "kpi-idle", "kpi-pr"]) {
    const el = new MockElement("span");
    el.className = `kpi-chip ${kpi}`;
    stageWrapper.appendChild(el);
  }

  const sandbox: any = {
    window: {
      addEventListener(evt: string, cb: Function) {
        if (!windowListeners[evt]) windowListeners[evt] = [];
        windowListeners[evt].push(cb);
      },
      innerWidth: 800,
      innerHeight: 540,
      devicePixelRatio: 1,
      matchMedia() {
        return { matches: false };
      },
    } as any,
    document: {
      getElementById(id: string) {
        if (elements.has(id)) return elements.get(id);
        return stageWrapper.querySelector("#" + id);
      },
      createElement(tag: string) {
        const el = new MockElement(tag);
        if (tag.toLowerCase() === "canvas") {
          el.getContext = () => mockCtx;
        }
        return el;
      },
      createTextNode(text: string) {
        const el = new MockElement("text");
        el.textContent = text;
        return el;
      },
      querySelector(sel: string) {
        return stageWrapper.querySelector(sel);
      },
      querySelectorAll(sel: string) {
        return stageWrapper.querySelectorAll(sel);
      },
      addEventListener(evt: string, cb: Function) {
        stageWrapper.addEventListener(evt, cb);
      },
    },
    innerWidth: 800,
    innerHeight: 540,
    devicePixelRatio: 1,
    matchMedia() {
      return { matches: false };
    },
    Image: class {
      src = "";
      complete = false;
      naturalWidth = 0;
    },
    fetch: async (...args: any[]) => {
      fetchCalls.push(args);
      return { ok: true, status: 200, json: async () => ({}) };
    },
    setInterval() {
      return 1;
    },
    setTimeout,
    requestAnimationFrame() {
      return 1;
    },
    performance: { now: () => 1000 },
    Math,
    Date,
    Number,
    String,
    Array,
    Object,
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.document = sandbox.document;

  const vmCtx = vm.createContext(sandbox);
  vm.runInContext(script, vmCtx);

  const evalInContext = (code: string) => vm.runInContext(code, vmCtx);

  const triggerStageClick = (x: number, y: number, target?: any) => {
    stageWrapper.trigger("click", {
      clientX: x,
      clientY: y,
      target: target || canvasEl,
      stopPropagation() {},
    });
  };

  const triggerKey = (key: string) => {
    for (const h of windowListeners["keydown"] || []) {
      h({ key });
    }
  };

  return {
    vmCtx,
    mockCtx,
    fillTextCalls,
    fetchCalls,
    stageWrapper,
    evalInContext,
    triggerStageClick,
    triggerKey,
  };
}

describe("DT-20261121-office-board: Sprint board title formatting and clearance", () => {
  it("exports cleanBoardTaskTitle and fitBoardTitle on the window context", () => {
    const { evalInContext } = createBoardHarness();
    expect(evalInContext("typeof cleanBoardTaskTitle")).toBe("function");
    expect(evalInContext("typeof fitBoardTitle")).toBe("function");
  });

  it("case a: 'سالم' + 'DT-20261121-social-fill', 5% -> ends with '…', percent right < title left", () => {
    const { evalInContext, mockCtx } = createBoardHarness();

    const bot = {
      name: "سالم",
      taskId: "DT-20261121-social-fill",
      status: "working",
      progress: 5,
    };
    const cleanBoardTaskTitle = evalInContext("cleanBoardTaskTitle");
    const fitBoardTitle = evalInContext("fitBoardTitle");

    const rawTitle = cleanBoardTaskTitle(bot);
    expect(rawTitle).toBe("DT-20261121-social-fill");

    const slot = { tx: 125 + 185 - 8, px: 125 + 185 / 2 + 12, y: 7 + 21 }; // tx: 302, px: 229.5
    const pctText = bot.progress + "%";
    const percentWidth = mockCtx.measureText(pctText).width;
    const availWidth = (slot.tx - slot.px) - percentWidth - 6;

    const titleText = fitBoardTitle(mockCtx, bot.name, rawTitle, availWidth);
    expect(titleText.endsWith("…")).toBe(true);

    const titleWidth = mockCtx.measureText(titleText).width;
    expect(titleWidth).toBeLessThanOrEqual(availWidth);

    const leftEndOfTitle = slot.tx - titleWidth;
    const rightEndOfPercent = slot.px + percentWidth;
    expect(rightEndOfPercent).toBeLessThan(leftEndOfTitle);
    expect(leftEndOfTitle - rightEndOfPercent).toBeGreaterThanOrEqual(6);
  });

  it("case b: Long Arabic title 'تطبيق خطة استكمال الوسائط الاجتماعية v4' -> cut with '…', no overlap", () => {
    const { evalInContext, mockCtx } = createBoardHarness();
    const cleanBoardTaskTitle = evalInContext("cleanBoardTaskTitle");
    const fitBoardTitle = evalInContext("fitBoardTitle");

    const bot = {
      name: "هجرس",
      task_title: "تطبيق خطة استكمال الوسائط الاجتماعية v4",
      status: "working",
      progress: 40,
    };
    const rawTitle = cleanBoardTaskTitle(bot);
    expect(rawTitle).toBe("تطبيق خطة استكمال الوسائط الاجتماعية v4");

    const slot = { tx: 302, px: 229.5, y: 28 };
    const pctText = bot.progress + "%";
    const percentWidth = mockCtx.measureText(pctText).width;
    const availWidth = (slot.tx - slot.px) - percentWidth - 6;

    const titleText = fitBoardTitle(mockCtx, bot.name, rawTitle, availWidth);
    expect(titleText.endsWith("…")).toBe(true);

    const titleWidth = mockCtx.measureText(titleText).width;
    expect(titleWidth).toBeLessThanOrEqual(availWidth);

    const leftEndOfTitle = slot.tx - titleWidth;
    const rightEndOfPercent = slot.px + percentWidth;
    expect(rightEndOfPercent).toBeLessThan(leftEndOfTitle);
    expect(leftEndOfTitle - rightEndOfPercent).toBeGreaterThanOrEqual(6);
  });

  it("case c: Short title 'NEW-ISSUES-13' that fits -> drawn whole, no '…'", () => {
    const { evalInContext, mockCtx } = createBoardHarness();
    const cleanBoardTaskTitle = evalInContext("cleanBoardTaskTitle");
    const fitBoardTitle = evalInContext("fitBoardTitle");

    const bot = {
      name: "جوني",
      task: "NEW-ISSUES-13",
      status: "working",
      progress: 90,
    };
    const rawTitle = cleanBoardTaskTitle(bot);
    expect(rawTitle).toBe("NEW-ISSUES-13");

    const availWidth = 200;
    const titleText = fitBoardTitle(mockCtx, bot.name, rawTitle, availWidth);
    expect(titleText).toBe("جوني: NEW-ISSUES-13");
    expect(titleText).not.toContain("…");
  });

  it("case d: Stuck bot -> red percent with ⚠️, title has no 'متأخر'", () => {
    const { evalInContext } = createBoardHarness();
    const cleanBoardTaskTitle = evalInContext("cleanBoardTaskTitle");

    const bot1 = {
      name: "سالم",
      task_title: "استكمال خطة الوسائط",
      shortTask: "استكمال خطة الوسائط 🔴 متأخر",
      task: "مهمة مفتوحة بدون تحديث لأكثر من ٤٥ دقيقة",
      status: "stuck",
      progress: 5,
    };
    const rawTitle1 = cleanBoardTaskTitle(bot1);
    expect(rawTitle1).toBe("استكمال خطة الوسائط");
    expect(rawTitle1).not.toContain("متأخر");
    expect(rawTitle1).not.toContain("🔴");

    const bot2 = {
      name: "سالم",
      taskId: "DT-20261121-social-fill",
      shortTask: "DT-20261121-social-fill 🔴 متأخر",
      task: "DT-20261121-social-fill 🔴 متأخر",
      status: "stuck",
      progress: 5,
    };
    const rawTitle2 = cleanBoardTaskTitle(bot2);
    expect(rawTitle2).toBe("DT-20261121-social-fill");
    expect(rawTitle2).not.toContain("متأخر");
    expect(rawTitle2).not.toContain("🔴");

    const pctText = bot1.progress + "%" + (bot1.status === "stuck" ? " ⚠️" : "");
    expect(pctText).toBe("5% ⚠️");
  });

  it("case e: 0 active bots -> still renders 'لا توجد مهام نشطة حالياً'", () => {
    const { evalInContext, fillTextCalls } = createBoardHarness();

    evalInContext(`
      for (const k of BOT_KEYS) {
        BOTS[k].status = "idle";
        BOTS[k].feedStatus = "idle";
      }
    `);

    fillTextCalls.length = 0;
    evalInContext("drawDynamicWallBoards()");

    const emptyCall = fillTextCalls.find((c) => c.text === "لا توجد مهام نشطة حالياً");
    expect(emptyCall).toBeDefined();
    expect(emptyCall?.textAlign).toBe("center");
  });

  it("sets ctx.direction = 'rtl' while drawing title and restores to original direction", () => {
    const { evalInContext, mockCtx, fillTextCalls } = createBoardHarness();

    evalInContext(`
      for (const k of BOT_KEYS) {
        BOTS[k].status = (k === "johnny") ? "working" : "idle";
        BOTS[k].feedStatus = (k === "johnny") ? "working" : "idle";
      }
      BOTS.johnny.task = "NEW-ISSUES-13";
      BOTS.johnny.progress = 50;
    `);

    mockCtx.direction = "ltr";
    fillTextCalls.length = 0;
    evalInContext("drawDynamicWallBoards()");

    const titleCall = fillTextCalls.find((c) => c.text.includes("جوني:"));
    expect(titleCall).toBeDefined();
    expect(titleCall?.direction).toBe("rtl");
    expect(mockCtx.direction).toBe("ltr");
  });
});

describe("DT-20261121-office-board: Employee status card and cheer action (D-0160)", () => {
  it("case a: Click on جوني (working, 85%) -> card shows Arabic title, step, 85%, and next", () => {
    const { evalInContext, stageWrapper } = createBoardHarness();

    evalInContext(`
      const nowIso = new Date().toISOString();
      BOTS.johnny.status = 'working';
      BOTS.johnny.feedStatus = 'working';
      BOTS.johnny.name = 'جوني';
      BOTS.johnny.taskTitle = 'خطة استكمال الوسائط';
      BOTS.johnny.task_title = 'خطة استكمال الوسائط';
      BOTS.johnny.step = 'تنفيذ المنطق';
      BOTS.johnny.progress = 85;
      BOTS.johnny.next = 'مراجعة أشرف';
      BOTS.johnny.updatedAt = nowIso;
      openAgentCard('johnny');
    `);

    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card).toBeDefined();
    expect(card.style.display).toBe("block");

    const nameEl = card.querySelector(".card-name");
    expect(nameEl?.textContent).toBe("جوني");

    const statusEl = card.querySelector(".card-status-row");
    expect(statusEl?.textContent).toContain("🟢 شغال");
    expect(statusEl?.textContent).toContain("85%");

    expect(card.textContent).toContain("خطة استكمال الوسائط");
    expect(card.textContent).toContain("تنفيذ المنطق");
    expect(card.textContent).toContain("85%");
    expect(card.textContent).toContain("مراجعة أشرف");
  });

  it("case b: Click on حزلقوم (idle) -> only the name + متاح (no task, step, or next rows)", () => {
    const { evalInContext, stageWrapper } = createBoardHarness();

    evalInContext(`
      BOTS.hazalqom.status = 'idle';
      BOTS.hazalqom.feedStatus = 'idle';
      BOTS.hazalqom.name = 'حزلقوم';
      BOTS.hazalqom.progress = 0;
      openAgentCard('hazalqom');
    `);

    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card).toBeDefined();
    expect(card.style.display).toBe("block");

    const nameEl = card.querySelector(".card-name");
    expect(nameEl?.textContent).toBe("حزلقوم");

    const statusEl = card.querySelector(".card-status-row");
    expect(statusEl?.textContent).toContain("☕ متاح");

    // Details rows should not exist for idle bot
    expect(card.querySelectorAll(".card-detail-row").length).toBe(0);
  });

  it("case c: A stuck bot -> red متأخر label with ⚠️", () => {
    const { evalInContext, stageWrapper } = createBoardHarness();

    evalInContext(`
      BOTS.salem.status = 'stuck';
      BOTS.salem.feedStatus = 'stuck';
      BOTS.salem.name = 'سالم';
      BOTS.salem.progress = 25;
      BOTS.salem.taskId = 'DT-123';
      openAgentCard('salem');
    `);

    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card).toBeDefined();

    const statusEl = card.querySelector(".card-status-row");
    expect(statusEl?.textContent).toContain("🔴 متأخر");
    expect(statusEl?.textContent).toContain("⚠️");
  });

  it("case d: A task_title containing '<b>x</b>' -> shown as plain text, not as HTML", () => {
    const { evalInContext, stageWrapper } = createBoardHarness();

    evalInContext(`
      BOTS.johnny.status = 'working';
      BOTS.johnny.feedStatus = 'working';
      BOTS.johnny.taskTitle = '<b>x</b>';
      BOTS.johnny.task_title = '<b>x</b>';
      BOTS.johnny.task = '<b>x</b>';
      BOTS.johnny.progress = 50;
      openAgentCard('johnny');
    `);

    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card.textContent).toContain("<b>x</b>");
    // Should NOT have created a <b> DOM node
    expect(card.querySelector("b")).toBeNull();
  });

  it("case e: Click on empty floor -> card closes; Esc -> card closes; click other bot -> switches", () => {
    const { evalInContext, stageWrapper, triggerKey } = createBoardHarness();

    evalInContext(`
      BOTS.johnny.status = 'working';
      BOTS.johnny.name = 'جوني';

      BOTS.nafady.status = 'working';
      BOTS.nafady.name = 'نفادي';
      openAgentCard('johnny');
    `);

    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card.style.display).toBe("block");
    expect(card.querySelector(".card-name")?.textContent).toBe("جوني");

    // Close card via closeAgentCard
    evalInContext("closeAgentCard()");
    expect(card.style.display).toBe("none");

    // Open Johnny again
    evalInContext("openAgentCard('johnny')");
    expect(card.style.display).toBe("block");

    // Press Escape -> closes
    triggerKey("Escape");
    expect(card.style.display).toBe("none");

    // Click close button (✕) -> closes
    evalInContext("openAgentCard('johnny')");
    expect(card.style.display).toBe("block");
    const closeBtn = card.querySelector(".card-close");
    closeBtn?.trigger("click", { stopPropagation() {} });
    expect(card.style.display).toBe("none");

    // Switch bot to Nafady
    evalInContext("openAgentCard('johnny')");
    expect(card.querySelector(".card-name")?.textContent).toBe("جوني");
    evalInContext("openAgentCard('nafady')");
    expect(card.querySelector(".card-name")?.textContent).toBe("نفادي");
  });

  it("case f: Cheer button -> bubble shows above bot and NO fetch/XHR happens", () => {
    const { evalInContext, stageWrapper, fetchCalls } = createBoardHarness();

    evalInContext(`
      BOTS.johnny.status = 'working';
      BOTS.johnny.name = 'جوني';
      openAgentCard('johnny');
    `);

    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    const cheerBtn = card.querySelector(".card-btn.cheer");
    expect(cheerBtn).toBeDefined();

    fetchCalls.length = 0;
    cheerBtn?.trigger("click", { stopPropagation() {} });

    // celebrateBot was called locally
    expect(evalInContext("BOTS.johnny.bubbleText")).toBe(evalInContext("CHEER_REPLIES.johnny"));
    expect(evalInContext("BOTS.johnny.bubbleUntil")).toBeGreaterThan(1000);

    // No network requests or XHR made
    expect(fetchCalls.length).toBe(0);
  });
});

describe("DT-20261121-office-v47: Must-Pass Verification Suite", () => {
  it("Must-Pass 1 (CI Waiting Test): bot with state waiting for 2h remains waiting and displays real percent, never stuck", () => {
    const { evalInContext, stageWrapper } = createBoardHarness();

    const twoHoursAgoIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    evalInContext(`
      const payload = {
        version: 1,
        generated_at: new Date().toISOString(),
        bots: {
          marbouha: {
            bot: 'marbouha',
            state: 'waiting',
            task_id: 'CI-CHECK-99',
            task_title: 'فحص جودة واختبارات',
            step: 'بانتظار اكتمال فحص CI',
            percent: 64,
            next: 'اعتماد التقرير',
            open_order: true,
            updated_at: '${twoHoursAgoIso}',
            recent: []
          }
        }
      };
      applyLiveFeed(payload);
    `);

    expect(evalInContext("BOTS.marbouha.status")).toBe("waiting");
    expect(evalInContext("BOTS.marbouha.progress")).toBe(64);

    evalInContext("openAgentCard('marbouha')");
    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card).toBeDefined();

    const statusEl = card.querySelector(".card-status-row");
    expect(statusEl?.textContent).toContain("⏳ في الانتظار");
    expect(statusEl?.textContent).toContain("64%");
  });

  it("Must-Pass 2 (CTO Percent Match Test): 72% in status.md matches 72% in board and card", () => {
    const { evalInContext, stageWrapper } = createBoardHarness();

    const nowIso = new Date().toISOString();
    evalInContext(`
      const payload = {
        version: 1,
        generated_at: '${nowIso}',
        bots: {
          hagras: {
            bot: 'hagras',
            state: 'working',
            task_id: 'DT-20261121-office-v2',
            task_title: 'تطوير مكتب ديجر v2',
            step: 'تنفيذ الشاشات والغرف',
            percent: 72,
            next: 'مراجعة أشرف ومربوحة',
            open_order: true,
            updated_at: '${nowIso}',
            recent: []
          }
        }
      };
      applyLiveFeed(payload);
    `);

    expect(evalInContext("BOTS.hagras.progress")).toBe(72);

    evalInContext("openAgentCard('hagras')");
    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card.textContent).toContain("72%");
  });

  it("Must-Pass 4 (Cheer Test for all 10 bots): Egyptian banter bubbles without network requests", () => {
    const { evalInContext, stageWrapper, fetchCalls } = createBoardHarness();

    const botKeys: string[] = evalInContext("BOT_KEYS");
    expect(botKeys.length).toBe(10);

    for (const key of botKeys) {
      fetchCalls.length = 0;

      evalInContext(`openAgentCard('${key}')`);
      const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
      expect(card.style.display).toBe("block");

      const cheerBtn = card.querySelector(".card-btn.cheer");
      expect(cheerBtn).toBeDefined();

      cheerBtn?.trigger("click", { stopPropagation() {} });

      const expectedReply = evalInContext(`CHEER_REPLIES['${key}']`);
      expect(evalInContext(`BOTS['${key}'].bubbleText`)).toBe(expectedReply);
      expect(fetchCalls.length).toBe(0);

      evalInContext("closeAgentCard()");
    }
  });

  it("Must-Pass 5 (Meeting Feature): meeting button triggers team meeting and moves bots to meeting room", () => {
    const { evalInContext, stageWrapper } = createBoardHarness();

    const meetingBtn = stageWrapper.querySelector(".meeting-btn");
    expect(meetingBtn).toBeDefined();

    evalInContext("triggerTeamMeeting()");
    expect(evalInContext("teamMeetingActive")).toBe(true);

    const botKeys: string[] = evalInContext("BOT_KEYS");
    for (const key of botKeys) {
      expect(evalInContext(`BOTS['${key}'].status`)).toBe("meeting");
    }

    // Verify all 10 seats in MEETING_SEATS are populated
    for (const key of botKeys) {
      const seat = evalInContext(`MEETING_SEATS['${key}']`);
      expect(seat).toBeDefined();
      expect(seat.x).toBeGreaterThan(0);
      expect(seat.y).toBeGreaterThan(0);
    }

    // End meeting
    evalInContext("endTeamMeeting()");
    expect(evalInContext("teamMeetingActive")).toBe(false);
  });

  it("Must-Pass 6 (Sleeping Gag Test): working/waiting never sleep; idle >30m sleeps; tap wakes up without modal", () => {
    const { evalInContext } = createBoardHarness();

    const fortyMinsAgo = Date.now() - 40 * 60 * 1000;
    evalInContext(`
      // 1. Working bot: never sleeps
      BOTS.hagras.status = 'working';
      BOTS.hagras.feedStatus = 'working';
      BOTS.hagras.updatedAt = new Date(${fortyMinsAgo}).toISOString();
      checkBotSleep(BOTS.hagras, Date.now());

      // 2. Waiting bot: never sleeps
      BOTS.marbouha.status = 'waiting';
      BOTS.marbouha.feedStatus = 'waiting';
      BOTS.marbouha.updatedAt = new Date(${fortyMinsAgo}).toISOString();
      checkBotSleep(BOTS.marbouha, Date.now());

      // 3. Idle bot > 30m: sleeps
      BOTS.salem.status = 'idle';
      BOTS.salem.feedStatus = 'idle';
      BOTS.salem.updatedAt = new Date(${fortyMinsAgo}).toISOString();
      BOTS.salem.idleSince = ${fortyMinsAgo};
      checkBotSleep(BOTS.salem, Date.now());
    `);

    expect(evalInContext("BOTS.hagras.isSleeping")).toBe(false);
    expect(evalInContext("BOTS.marbouha.isSleeping")).toBe(false);
    expect(evalInContext("BOTS.salem.isSleeping")).toBe(true);

    // Wake up Salem
    evalInContext("wakeUpBot(BOTS.salem)");

    expect(evalInContext("BOTS.salem.isSleeping")).toBe(false);
    const apology = evalInContext("BOTS.salem.bubbleText");
    expect(apology).toBeTruthy();
    expect(evalInContext("WAKE_APOLOGIES")).toContain(apology);
  });

  it("Must-Pass 7 (DOM Security Test): zero innerHTML and safe textContent rendering", () => {
    const { evalInContext, stageWrapper } = createBoardHarness();

    const malicious = '<img src=x onerror=alert(1)>';
    evalInContext(`
      BOTS.johnny.status = 'working';
      BOTS.johnny.feedStatus = 'working';
      BOTS.johnny.taskTitle = '${malicious}';
      BOTS.johnny.task_title = '${malicious}';
      BOTS.johnny.step = '${malicious}';
      BOTS.johnny.next = '${malicious}';
      BOTS.johnny.activity_type = '${malicious}';
      BOTS.johnny.progress = 50;
      openAgentCard('johnny');
    `);

    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    // Only the avatar img should exist, no malicious injected img
    const imgs = card.querySelectorAll("img");
    expect(imgs.length).toBe(1);
    expect(imgs[0].className).toContain("card-avatar");
    expect(card.textContent).toContain(malicious);
  });

  it("Must-Pass: two quick cheers on two bots -> only the last bot shows a bubble", () => {
    const { evalInContext } = createBoardHarness();
    evalInContext(`
      celebrateBot(BOTS.johnny, 'اول تشجيع');
      celebrateBot(BOTS.salem, 'تاني تشجيع');
    `);
    expect(evalInContext("BOTS.johnny.bubbleText")).toBe("");
    expect(evalInContext("BOTS.johnny.bubbleUntil")).toBe(0);
    expect(evalInContext("BOTS.salem.bubbleText")).toBe("تاني تشجيع");
    expect(evalInContext("BOTS.salem.bubbleUntil")).toBeGreaterThan(0);
  });

  it("Forbidden Words Absence Test: commercial game and platform names absent from office code", () => {
    const html = readFileSync("public/office/index.html", "utf8");
    const forbidden = ["Z3Rh", "Z3JhbmQgdGhlZnQ=", "cm9ja3N0YXI=", "cGxheXN0YXRpb24=", "c29ueQ=="]
      .map((b) => new RegExp("\\b" + Buffer.from(b, "base64").toString("utf-8") + "\\b", "i"));
    for (const re of forbidden) {
      expect(html).not.toMatch(re);
    }
  });

  it("Must-Pass: real feed timestamps and sleep integration tests (a)-(d)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "office-realfeed-"));
    const statusDir = path.join(tmpDir, "status");
    const tasksDir = path.join(tmpDir, "tasks");
    const workDir = path.join(tmpDir, "work");
    fs.mkdirSync(statusDir, { recursive: true });
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });

    const workDirs: Record<string, string> = {};
    for (const b of ["elkebir", "johnny", "nafady", "hagras", "salem", "hazalqom", "fazza", "ashraf", "marbouha"]) {
      workDirs[b] = path.join(workDir, b);
      fs.mkdirSync(workDirs[b], { recursive: true });
    }

    const now = Date.now();
    const fourHoursAgo = new Date(now - 4 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

    // (a) Hazalqom: status line 4h old, state idle
    fs.writeFileSync(
      path.join(statusDir, "hazalqom.jsonl"),
      JSON.stringify({
        bot: "hazalqom",
        state: "idle",
        updated_at: fourHoursAgo,
        open_order: false,
      }) + "\n"
    );

    // (b) Johnny: status line 4h old, state working with open order
    fs.writeFileSync(
      path.join(statusDir, "johnny.jsonl"),
      JSON.stringify({
        bot: "johnny",
        state: "working",
        task_id: "DT-TASK-01",
        updated_at: fourHoursAgo,
        open_order: true,
      }) + "\n"
    );

    // (c) Salem: status line 4h old, state waiting
    fs.writeFileSync(
      path.join(statusDir, "salem.jsonl"),
      JSON.stringify({
        bot: "salem",
        state: "waiting",
        task_id: "DT-TASK-02",
        percent: 85,
        updated_at: fourHoursAgo,
        open_order: true,
      }) + "\n"
    );

    // (d) Nafady: no status line -> null last_active

    const feed = (buildOfficeFeed as any)({
      statusDir,
      tasksDir,
      workDirs,
      nowMs: now,
    });

    expect(feed.bots.hazalqom.last_active).toBe(fourHoursAgo);
    expect(feed.bots.hazalqom.updated_at).toBe(fourHoursAgo);
    expect(feed.bots.hazalqom.state).toBe("idle");

    expect(feed.bots.johnny.state).toBe("stuck");
    expect(feed.bots.salem.state).toBe("waiting");
    expect(feed.bots.nafady.last_active).toBeNull();
    expect(feed.bots.nafady.updated_at).toBeNull();

    const { evalInContext } = createBoardHarness();

    evalInContext(`
      applyLiveFeed(${JSON.stringify(feed)});
      checkBotSleep(BOTS.hazalqom, Date.now());
      checkBotSleep(BOTS.johnny, Date.now());
      checkBotSleep(BOTS.salem, Date.now());
      checkBotSleep(BOTS.nafady, Date.now());
    `);

    // (a) Hazalqom: idle for 4h -> isSleeping true on first load
    expect(evalInContext("BOTS.hazalqom.isSleeping")).toBe(true);

    // Wake up Hazalqom -> apology bubble
    evalInContext("wakeUpBot(BOTS.hazalqom)");
    expect(evalInContext("BOTS.hazalqom.isSleeping")).toBe(false);
    expect(evalInContext("BOTS.hazalqom.wakeAnimStart")).toBeGreaterThan(0);
    const apology = evalInContext("BOTS.hazalqom.bubbleText");
    expect(apology).toBeTruthy();
    expect(evalInContext("WAKE_APOLOGIES")).toContain(apology);

    // (b) Counter: Johnny working with 4h old line -> never نايم
    expect(evalInContext("BOTS.johnny.isSleeping")).toBe(false);
    expect(evalInContext("BOTS.johnny.status")).toBe("stuck");

    // (c) Counter: Salem waiting with 4h old line -> never نايم and never «متأخر»
    expect(evalInContext("BOTS.salem.isSleeping")).toBe(false);
    expect(evalInContext("BOTS.salem.status")).toBe("waiting");
    expect(evalInContext("BOTS.salem.statusLabel")).not.toContain("متأخر");

    // (d) Counter: Nafady with null last_active -> not sleeping on load, no crash
    expect(evalInContext("BOTS.nafady.isSleeping")).toBe(false);
    expect(evalInContext("BOTS.nafady.updatedAt")).toBeNull();
  });

  describe("DT-20261121-office-sleep: Hazalqom wandering designer sleep mechanics (Must-Pass a-g)", () => {
    it("case a: hazalqom idle < 30 min -> wanders, label '☕ متاح', isSleeping false", () => {
      const { evalInContext } = createBoardHarness();
      const now = Date.now();
      evalInContext(`
        const now = ${now};
        BOTS.hazalqom.status = 'idle';
        BOTS.hazalqom.feedStatus = 'idle';
        BOTS.hazalqom.updatedAt = new Date(now - 10 * 60 * 1000).toISOString();
        BOTS.hazalqom.idleSince = now - 10 * 60 * 1000;
        BOTS.hazalqom.x = 582;
        BOTS.hazalqom.y = 205;
        checkBotSleep(BOTS.hazalqom, now);
        openAgentCard('hazalqom');
      `);
      expect(evalInContext("BOTS.hazalqom.isSleeping")).toBe(false);
      expect(evalInContext("BOTS.hazalqom.wander")).toBe(true);
      const cardText = evalInContext("document.getElementById('agent-card-popup').textContent");
      expect(cardText).toContain("☕ متاح");
      expect(cardText).not.toContain("نايم");
    });

    it("case b: idle >= 30 min while away from desk -> walks home with label still متاح, then at desk isSleeping true, Zzz, no movement", () => {
      const { evalInContext } = createBoardHarness();
      const now = Date.now();
      evalInContext(`
        const now = ${now};
        BOTS.hazalqom.status = 'idle';
        BOTS.hazalqom.feedStatus = 'idle';
        BOTS.hazalqom.updatedAt = new Date(now - 35 * 60 * 1000).toISOString();
        BOTS.hazalqom.idleSince = now - 35 * 60 * 1000;
        // Away from desk:
        BOTS.hazalqom.x = 582;
        BOTS.hazalqom.y = 205;
        BOTS.hazalqom.wander = true;
        BOTS.hazalqom.returningHome = false;
        BOTS.hazalqom.isSleeping = false;

        // Check sleep while away from desk
        checkBotSleep(BOTS.hazalqom, now);
        openAgentCard('hazalqom');
      `);

      // 1. Away from desk: must NOT sleep yet! Must start returning home, wander = false
      expect(evalInContext("BOTS.hazalqom.isSleeping")).toBe(false);
      expect(evalInContext("BOTS.hazalqom.wander")).toBe(false);
      expect(evalInContext("BOTS.hazalqom.returningHome")).toBe(true);
      const cardTextWalking = evalInContext("document.getElementById('agent-card-popup').textContent");
      expect(cardTextWalking).toContain("☕ متاح");
      expect(cardTextWalking).not.toContain("نايم");

      // 2. Simulate arrival at desk
      evalInContext(`
        BOTS.hazalqom.x = BOTS.hazalqom.homeX;
        BOTS.hazalqom.y = BOTS.hazalqom.homeY;
        BOTS.hazalqom.returningHome = false;
        checkBotSleep(BOTS.hazalqom, now);
        openAgentCard('hazalqom');
      `);
      expect(evalInContext("BOTS.hazalqom.isSleeping")).toBe(true);
      expect(evalInContext("BOTS.hazalqom.isMoving")).toBe(false);
      const cardTextAtDesk = evalInContext("document.getElementById('agent-card-popup').textContent");
      expect(cardTextAtDesk).toContain("💤 نايم على مكتبه");

      // 3. updateWorld must NOT move sleeping bot
      evalInContext(`
        const prevX = BOTS.hazalqom.x;
        const prevY = BOTS.hazalqom.y;
        updateWorld(0.1, 2000);
      `);
      expect(evalInContext("BOTS.hazalqom.x")).toBe(evalInContext("BOTS.hazalqom.homeX"));
      expect(evalInContext("BOTS.hazalqom.y")).toBe(evalInContext("BOTS.hazalqom.homeY"));
      expect(evalInContext("BOTS.hazalqom.isMoving")).toBe(false);
    });

    it("case c: Several feed polls while asleep -> does not start walking again, stays asleep at desk", () => {
      const { evalInContext } = createBoardHarness();
      const now = Date.now();
      evalInContext(`
        const now = ${now};
        BOTS.hazalqom.status = 'idle';
        BOTS.hazalqom.feedStatus = 'idle';
        BOTS.hazalqom.x = BOTS.hazalqom.homeX;
        BOTS.hazalqom.y = BOTS.hazalqom.homeY;
        BOTS.hazalqom.isSleeping = true;
        BOTS.hazalqom.wander = false;
        BOTS.hazalqom.isMoving = false;

        const payload = {
          version: 1,
          bots: {
            hazalqom: {
              bot: "hazalqom",
              state: "idle",
              percent: null,
              updated_at: new Date(now - 40 * 60 * 1000).toISOString()
            }
          }
        };

        // Poll 1
        applyLiveFeed(payload);
        // Poll 2
        applyLiveFeed(payload);
        // Poll 3
        applyLiveFeed(payload);
      `);

      expect(evalInContext("BOTS.hazalqom.isSleeping")).toBe(true);
      expect(evalInContext("BOTS.hazalqom.wander")).toBe(false);
      expect(evalInContext("BOTS.hazalqom.isMoving")).toBe(false);
    });

    it("case d: Click to wake -> awake, wanders again; no sleep during the 10-min cooldown", () => {
      const { evalInContext } = createBoardHarness();
      const now = Date.now();
      evalInContext(`
        const now = ${now};
        BOTS.hazalqom.status = 'idle';
        BOTS.hazalqom.feedStatus = 'idle';
        BOTS.hazalqom.x = BOTS.hazalqom.homeX;
        BOTS.hazalqom.y = BOTS.hazalqom.homeY;
        BOTS.hazalqom.isSleeping = true;
        BOTS.hazalqom.wander = false;

        wakeUpBot(BOTS.hazalqom);
      `);

      expect(evalInContext("BOTS.hazalqom.isSleeping")).toBe(false);
      expect(evalInContext("BOTS.hazalqom.wander")).toBe(true);

      // During cooldown (e.g. 5 min after wake-up, even though idleSince is 50 min ago)
      evalInContext(`
        checkBotSleep(BOTS.hazalqom, now + 5 * 60 * 1000);
      `);
      expect(evalInContext("BOTS.hazalqom.isSleeping")).toBe(false);
      expect(evalInContext("BOTS.hazalqom.wander")).toBe(true);
    });

    it("case e: Feed changes him to working -> wakes, goes to desk (existing behaviour unchanged)", () => {
      const { evalInContext } = createBoardHarness();
      const now = Date.now();
      evalInContext(`
        const now = ${now};
        BOTS.hazalqom.status = 'idle';
        BOTS.hazalqom.feedStatus = 'idle';
        BOTS.hazalqom.x = 582;
        BOTS.hazalqom.y = 205;
        BOTS.hazalqom.isSleeping = true;

        const workingPayload = {
          version: 1,
          bots: {
            hazalqom: {
              bot: "hazalqom",
              state: "working",
              task_title: "تصميم واجهة جديدة",
              percent: 40,
              updated_at: new Date(now).toISOString()
            }
          }
        };

        applyLiveFeed(workingPayload);
      `);

      expect(evalInContext("BOTS.hazalqom.isSleeping")).toBe(false);
      expect(evalInContext("BOTS.hazalqom.feedStatus")).toBe("working");
      expect(evalInContext("BOTS.hazalqom.wander")).toBe(false);
      // Since he was away from desk (582, 205), returningHome is triggered to take him back
      expect(evalInContext("BOTS.hazalqom.returningHome")).toBe(true);
    });

    it("case f: Desk bots (all others, baseWander false) -> sleep behaviour exactly as today", () => {
      const { evalInContext } = createBoardHarness();
      const now = Date.now();
      evalInContext(`
        const now = ${now};
        BOTS.johnny.status = 'idle';
        BOTS.johnny.feedStatus = 'idle';
        BOTS.johnny.updatedAt = new Date(now - 35 * 60 * 1000).toISOString();
        BOTS.johnny.idleSince = now - 35 * 60 * 1000;
        BOTS.johnny.baseWander = false;

        checkBotSleep(BOTS.johnny, now);
      `);

      expect(evalInContext("BOTS.johnny.isSleeping")).toBe(true);
      expect(evalInContext("BOTS.johnny.isMoving")).toBe(false);
    });

    it("case g: Team meeting while asleep/returning -> meeting walk-in/walk-back unchanged; no sleep during meeting", () => {
      const { evalInContext } = createBoardHarness();
      const now = Date.now();
      evalInContext(`
        const now = ${now};
        BOTS.hazalqom.status = 'idle';
        BOTS.hazalqom.feedStatus = 'idle';
        BOTS.hazalqom.isSleeping = true;
        BOTS.hazalqom.wander = false;

        triggerTeamMeeting();
      `);

      expect(evalInContext("teamMeetingActive")).toBe(true);
      expect(evalInContext("BOTS.hazalqom.isSleeping")).toBe(false);

      // During meeting, checkBotSleep should never sleep
      evalInContext(`
        checkBotSleep(BOTS.hazalqom, now);
      `);
      expect(evalInContext("BOTS.hazalqom.isSleeping")).toBe(false);
    });
  });

  describe("DT-20261121-office-busy: busy bots never wander, 20s coffee with countdown", () => {
    it("case a: auto break never picks working / waiting / stuck / meeting bots; picks an idle one when available", () => {
      const { evalInContext } = createBoardHarness();
      evalInContext(`
        tripBot = null;
        nextTripAt = 1000;
        interaction = null;
        teamMeetingActive = false;

        // Set all bots to non-idle except hagras
        for (const k of BOT_KEYS) {
          BOTS[k].onTrip = false;
          BOTS[k].returningHome = false;
          BOTS[k].isSleeping = false;
          BOTS[k].feedStatus = 'working';
          BOTS[k].status = 'working';
        }
        BOTS.ashraf.feedStatus = 'working';
        BOTS.ashraf.status = 'working';
        BOTS.marbouha.feedStatus = 'waiting';
        BOTS.marbouha.status = 'waiting';
        BOTS.fazza.feedStatus = 'stuck';
        BOTS.fazza.status = 'stuck';
        BOTS.johnny.feedStatus = 'meeting';
        BOTS.johnny.status = 'meeting';

        // Only hagras is idle
        BOTS.hagras.feedStatus = 'idle';
        BOTS.hagras.status = 'idle';

        updateCoffeeTrip(1, 2000);
      `);

      expect(evalInContext("tripBot ? tripBot.id : null")).toBe("hagras");

      // Now set all bots busy (even hagras) -> auto break must pick NO ONE
      evalInContext(`
        if (tripBot) {
          tripBot.onTrip = false;
          tripBot = null;
        }
        nextTripAt = 2000;
        BOTS.hagras.feedStatus = 'working';
        BOTS.hagras.status = 'working';

        updateCoffeeTrip(1, 3000);
      `);

      expect(evalInContext("tripBot")).toBeNull();
    });

    it("case b: startStandup / startHelp never set onTrip or a route on a busy bot; help with a busy helpee + idle helper still works (only helper moves)", () => {
      const { evalInContext } = createBoardHarness();
      evalInContext(`
        tripBot = null;
        interaction = null;
        teamMeetingActive = false;

        // All bots busy
        for (const k of BOT_KEYS) {
          BOTS[k].onTrip = false;
          BOTS[k].returningHome = false;
          BOTS[k].isSleeping = false;
          BOTS[k].feedStatus = 'working';
          BOTS[k].status = 'working';
          BOTS[k].route = [];
        }

        const standupRes = startStandup(1000);
      `);
      expect(evalInContext("standupRes")).toBe(false);
      expect(evalInContext("BOT_KEYS.some(k => BOTS[k].onTrip)")).toBe(false);

      // startHelp with all busy bots
      evalInContext(`
        const helpBusyRes = startHelp(1000);
      `);
      expect(evalInContext("helpBusyRes")).toBe(false);

      // Now: helpee (ashraf) is busy (working), helper (hagras) is idle
      evalInContext(`
        BOTS.ashraf.feedStatus = 'working';
        BOTS.ashraf.status = 'working';
        BOTS.ashraf.onTrip = false;
        BOTS.ashraf.route = [];

        BOTS.hagras.feedStatus = 'idle';
        BOTS.hagras.status = 'idle';
        BOTS.hagras.onTrip = false;
        BOTS.hagras.route = [];

        // Run startHelp
        const helpRes = startHelp(1000);
      `);
      expect(evalInContext("helpRes")).toBe(true);
      expect(evalInContext("BOTS.hagras.onTrip")).toBe(true);
      expect(evalInContext("BOTS.hagras.route.length")).toBeGreaterThan(0);
      expect(evalInContext("BOTS.ashraf.onTrip")).toBe(false);
      expect(evalInContext("BOTS.ashraf.route.length")).toBe(0);
    });

    it("case c: wait phase = exactly 20000 ms for coffee and lounge", () => {
      const { evalInContext } = createBoardHarness();
      // Test coffee
      evalInContext(`
        tripBot = null;
        interaction = null;
        teamMeetingActive = false;
        BOTS.hagras.feedStatus = 'idle';
        BOTS.hagras.status = 'idle';
        sendBotOnBreak(BOTS.hagras, 'coffee');

        // Simulate arrival at coffee spot
        BOTS.hagras.x = BOTS.hagras.tripTarget.x;
        BOTS.hagras.y = BOTS.hagras.tripTarget.y;
        BOTS.hagras.route = [];

        updateCoffeeTrip(0.1, 2000);
      `);

      expect(evalInContext("BOTS.hagras.tripPhase")).toBe("wait");
      expect(evalInContext("BOTS.hagras.tripWait")).toBe(20000);

      // Test lounge
      evalInContext(`
        tripBot = null;
        BOTS.salem.feedStatus = 'idle';
        BOTS.salem.status = 'idle';
        sendBotOnBreak(BOTS.salem, 'lounge');

        BOTS.salem.x = BOTS.salem.tripTarget.x;
        BOTS.salem.y = BOTS.salem.tripTarget.y;
        BOTS.salem.route = [];

        updateCoffeeTrip(0.1, 3000);
      `);

      expect(evalInContext("BOTS.salem.tripPhase")).toBe("wait");
      expect(evalInContext("BOTS.salem.tripWait")).toBe(20000);
    });

    it("case c2: right after arrival the bubble text is the countdown «… · ٢٠ث» without being hidden by banter", () => {
      const { evalInContext, fillTextCalls } = createBoardHarness();
      evalInContext(`
        tripBot = null;
        interaction = null;
        teamMeetingActive = false;
        BOTS.hagras.feedStatus = 'idle';
        BOTS.hagras.status = 'idle';
        sendBotOnBreak(BOTS.hagras, 'coffee');

        // Fast forward arrival at coffee spot at time = 2000 (departure banter chatUntil was set)
        BOTS.hagras.x = BOTS.hagras.tripTarget.x;
        BOTS.hagras.y = BOTS.hagras.tripTarget.y;
        BOTS.hagras.route = [];

        updateCoffeeTrip(0.1, 2000);

        // Setup head coordinates for bubble rendering
        BOTS.hagras._headX = 700;
        BOTS.hagras._headY = 400;
        BOTS.hagras._headR = 10;
        drawBotBubble(BOTS.hagras, 2000, false);
      `);

      expect(evalInContext("BOTS.hagras.tripPhase")).toBe("wait");
      expect(evalInContext("BOTS.hagras.tripWait")).toBe(20000);
      expect(evalInContext("BOTS.hagras.chatUntil || 0")).toBe(0);

      // Bubble text drawn immediately on arrival is the countdown
      const countdownCall = fillTextCalls.find((c) => c.text.includes("☕ بيشرب القهوة"));
      expect(countdownCall).toBeDefined();
      expect(countdownCall?.text).toMatch(/(20|٢٠)ث/);
    });

    it("case d: countdown text at remaining 20000/15000/1000 ms shows 20/15/1 s; progress at 0 / 10 / 20 s = 0 / 50 / 100%", () => {
      const { evalInContext } = createBoardHarness();
      evalInContext(`
        tripBot = BOTS.hagras;
        BOTS.hagras.onTrip = true;
        BOTS.hagras.tripPhase = 'wait';
        BOTS.hagras.tripKind = 'coffee';
        BOTS.hagras.tripWait = 20000;
      `);

      // At 20000 ms (0s elapsed)
      const text20 = evalInContext("getBreakCountdownText(BOTS.hagras)");
      expect(text20).toContain("☕ بيشرب القهوة");
      expect(text20).toMatch(/(20|٢٠)ث/);
      expect(evalInContext("getBreakProgress(BOTS.hagras)")).toBe(0);

      // At 15000 ms (5s elapsed)
      evalInContext("BOTS.hagras.tripWait = 15000;");
      const text15 = evalInContext("getBreakCountdownText(BOTS.hagras)");
      expect(text15).toMatch(/(15|١٥)ث/);

      // At 10000 ms (10s elapsed)
      evalInContext("BOTS.hagras.tripWait = 10000;");
      expect(evalInContext("getBreakProgress(BOTS.hagras)")).toBe(0.5);

      // At 1000 ms (19s elapsed)
      evalInContext("BOTS.hagras.tripWait = 1000;");
      const text1 = evalInContext("getBreakCountdownText(BOTS.hagras)");
      expect(text1).toMatch(/(1|١)ث/);

      // At 0 ms (20s elapsed)
      evalInContext("BOTS.hagras.tripWait = 0;");
      expect(evalInContext("getBreakProgress(BOTS.hagras)")).toBe(1);

      // Lounge variant
      evalInContext(`
        BOTS.salem.onTrip = true;
        BOTS.salem.tripPhase = 'wait';
        BOTS.salem.tripKind = 'lounge';
        BOTS.salem.tripWait = 15000;
      `);
      const loungeText = evalInContext("getBreakCountdownText(BOTS.salem)");
      expect(loungeText).toContain("🎮 استراحة");
      expect(loungeText).toMatch(/(15|١٥)ث/);
    });

    it("case e: feed turns bot working mid-trip (go and wait) -> onTrip false, returningHome true, tripBot null", () => {
      const { evalInContext } = createBoardHarness();
      const now = Date.now();

      // Subcase 1: during 'go' phase
      evalInContext(`
        const now = ${now};
        BOTS.hagras.status = 'idle';
        BOTS.hagras.feedStatus = 'idle';
        sendBotOnBreak(BOTS.hagras, 'coffee');
        // Now BOTS.hagras is in 'go' phase, tripBot is BOTS.hagras

        const workingPayload = {
          version: 1,
          bots: {
            hagras: {
              bot: "hagras",
              state: "working",
              task_title: "شغل جديد عاجل",
              percent: 10,
              updated_at: new Date(now).toISOString()
            }
          }
        };

        applyLiveFeed(workingPayload);
      `);

      expect(evalInContext("BOTS.hagras.onTrip")).toBe(false);
      expect(evalInContext("BOTS.hagras.returningHome")).toBe(true);
      expect(evalInContext("tripBot")).toBeNull();

      // Subcase 2: during 'wait' phase
      evalInContext(`
        const now2 = ${now + 5000};
        BOTS.salem.status = 'idle';
        BOTS.salem.feedStatus = 'idle';
        sendBotOnBreak(BOTS.salem, 'coffee');
        BOTS.salem.tripPhase = 'wait';
        BOTS.salem.tripWait = 18000;

        const workingSalemPayload = {
          version: 1,
          bots: {
            salem: {
              bot: "salem",
              state: "working",
              task_title: "إصلاح عاجل",
              percent: 5,
              updated_at: new Date(now2).toISOString()
            }
          }
        };

        applyLiveFeed(workingSalemPayload);
      `);

      expect(evalInContext("BOTS.salem.onTrip")).toBe(false);
      expect(evalInContext("BOTS.salem.returningHome")).toBe(true);
      expect(evalInContext("tripBot")).toBeNull();
    });

    it("case e2: feed turns standup or help participant busy -> cancels interaction cleanly", () => {
      const { evalInContext } = createBoardHarness();
      evalInContext(`
        tripBot = null;
        interaction = null;
        teamMeetingActive = false;
        for (const k of BOT_KEYS) {
          BOTS[k].onTrip = false;
          BOTS[k].returningHome = false;
          BOTS[k].isSleeping = false;
          BOTS[k].feedStatus = 'idle';
          BOTS[k].status = 'idle';
        }
        startStandup(1000);
      `);
      expect(evalInContext("interaction && interaction.type")).toBe("standup");
      const presenterId = evalInContext("interaction.presenter.id");

      // Now presenter receives working feed
      evalInContext(`
        applyLiveFeed({
          version: 1,
          bots: {
            [interaction.presenter.id]: {
              bot: interaction.presenter.id,
              state: "working",
              task_title: "شغل جديد عاجل",
              percent: 10,
              updated_at: new Date().toISOString()
            }
          }
        });
      `);
      expect(evalInContext("interaction")).toBeNull();
      expect(evalInContext(`BOTS[${JSON.stringify(presenterId)}].onTrip`)).toBe(false);
      expect(evalInContext(`BOTS[${JSON.stringify(presenterId)}].returningHome`)).toBe(true);
    });

    it("case f: card button on busy bot -> no trip, shows busy bubble; on idle bot -> trip starts; stuck message unchanged", () => {
      const { evalInContext, stageWrapper } = createBoardHarness();

      // 1. Busy bot (working)
      evalInContext(`
        BOTS.ashraf.feedStatus = 'working';
        BOTS.ashraf.status = 'working';
        BOTS.ashraf.onTrip = false;
        tripBot = null;
        openAgentCard('ashraf');
      `);

      const cardAshraf = stageWrapper.querySelector("#agent-card-popup") as MockElement;
      expect(cardAshraf).toBeDefined();
      const coffeeBtnAshraf = cardAshraf.querySelector(".card-btn.coffee") as MockElement;
      expect(coffeeBtnAshraf).toBeDefined();

      coffeeBtnAshraf.onclick?.({ stopPropagation() {} });

      expect(evalInContext("BOTS.ashraf.onTrip")).toBe(false);
      expect(evalInContext("tripBot")).toBeNull();
      expect(evalInContext("BOTS.ashraf.bubbleText")).toBe("عندي شغل، أخلّص وأروح ☕");

      // 2. Stuck bot
      evalInContext(`
        BOTS.fazza.feedStatus = 'stuck';
        BOTS.fazza.status = 'stuck';
        BOTS.fazza.onTrip = false;
        openAgentCard('fazza');
      `);
      const cardFazza = stageWrapper.querySelector("#agent-card-popup") as MockElement;
      const coffeeBtnFazza = cardFazza.querySelector(".card-btn.coffee") as MockElement;
      coffeeBtnFazza.onclick?.({ stopPropagation() {} });

      expect(evalInContext("BOTS.fazza.onTrip")).toBe(false);
      expect(evalInContext("BOTS.fazza.bubbleText")).toBe("مش هينفع دلوقتي، عندي مشكلة شغالة 🔴");

      // 3. Idle bot
      evalInContext(`
        BOTS.hagras.feedStatus = 'idle';
        BOTS.hagras.status = 'idle';
        BOTS.hagras.onTrip = false;
        tripBot = null;
        openAgentCard('hagras');
      `);
      const cardHagras = stageWrapper.querySelector("#agent-card-popup") as MockElement;
      const coffeeBtnHagras = cardHagras.querySelector(".card-btn.coffee") as MockElement;
      coffeeBtnHagras.onclick?.({ stopPropagation() {} });

      expect(evalInContext("BOTS.hagras.onTrip")).toBe(true);
      expect(evalInContext("tripBot === BOTS.hagras")).toBe(true);
    });

    it("counter-cases: idle breaks, team meeting gathers all, sleep and wander unchanged, desk chat allowed when busy", () => {
      const { evalInContext } = createBoardHarness();

      // Desk chat works between two busy bots
      evalInContext(`
        tripBot = null;
        interaction = null;
        teamMeetingActive = false;
        BOTS.hagras.feedStatus = 'working';
        BOTS.nafady.feedStatus = 'working';
        BOTS.hagras.onTrip = false;
        BOTS.nafady.onTrip = false;
        BOTS.hagras.isSleeping = false;
        BOTS.nafady.isSleeping = false;

        const chatRes = startChat(1000);
      `);
      expect(evalInContext("chatRes")).toBe(true);
      expect(evalInContext("interaction && interaction.type")).toBe("chat");

      // Team meeting gathers everyone including busy bots
      evalInContext(`
        triggerTeamMeeting();
      `);
      expect(evalInContext("teamMeetingActive")).toBe(true);
      expect(evalInContext("BOTS.hagras.status")).toBe("meeting");
      expect(evalInContext("BOTS.nafady.status")).toBe("meeting");
      expect(evalInContext("BOTS.hagras.route.length > 0")).toBe(true);
      expect(evalInContext("BOTS.nafady.route.length > 0")).toBe(true);
    });
  });
});
