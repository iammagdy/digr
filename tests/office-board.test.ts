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
  textContent: string = "";
  children: MockElement[] = [];
  listeners: Record<string, Function[]> = {};
  onclick: Function | null = null;
  attributes: Record<string, string> = {};

  constructor(tagName: string, id: string = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  appendChild(child: MockElement) {
    this.children.push(child);
    return child;
  }

  removeChild(child: MockElement) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
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
      if (sel.startsWith(".") && el.className.split(" ").includes(sel.slice(1))) return el;
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
      if (sel.startsWith(".") && el.className.split(" ").includes(sel.slice(1))) list.push(el);
      else if (sel.startsWith("#") && el.id === sel.slice(1)) list.push(el);
      else if (el.tagName.toLowerCase() === sel.toLowerCase()) list.push(el);
      for (const c of el.children) check(c);
    };
    for (const c of this.children) check(c);
    return list;
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
        return new MockElement(tag);
      },
      addEventListener() {},
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
      }
    `);

    fillTextCalls.length = 0;
    evalInContext("drawWalls()");

    const emptyCall = fillTextCalls.find((c) => c.text === "لا توجد مهام نشطة حالياً");
    expect(emptyCall).toBeDefined();
    expect(emptyCall?.textAlign).toBe("center");
  });

  it("sets ctx.direction = 'rtl' while drawing title and restores to original direction", () => {
    const { evalInContext, mockCtx, fillTextCalls } = createBoardHarness();

    evalInContext(`
      for (const k of BOT_KEYS) {
        BOTS[k].status = (k === "johnny") ? "working" : "idle";
      }
      BOTS.johnny.task = "NEW-ISSUES-13";
      BOTS.johnny.progress = 50;
    `);

    mockCtx.direction = "ltr";
    fillTextCalls.length = 0;
    evalInContext("drawWalls()");

    const titleCall = fillTextCalls.find((c) => c.text.includes("جوني:"));
    expect(titleCall).toBeDefined();
    expect(titleCall?.direction).toBe("rtl");
    expect(mockCtx.direction).toBe("ltr");
  });
});

describe("DT-20261121-office-board: Employee status card and cheer action (D-0160)", () => {
  it("case a: Click on جوني (working, 85%) -> card shows Arabic title, step, 85%, and next", () => {
    const { evalInContext, stageWrapper, triggerStageClick } = createBoardHarness();

    evalInContext(`
      const nowIso = new Date().toISOString();
      BOTS.johnny.status = 'working';
      BOTS.johnny.name = 'جوني';
      BOTS.johnny.taskTitle = 'خطة استكمال الوسائط';
      BOTS.johnny.task_title = 'خطة استكمال الوسائط';
      BOTS.johnny.step = 'تنفيذ المنطق';
      BOTS.johnny.progress = 85;
      BOTS.johnny.next = 'مراجعة أشرف';
      BOTS.johnny.updatedAt = nowIso;
      effCamX = 400;
      effCamY = 270;
      cam.zoom = 1;
    `);

    // Johnny is at homeX: 300, homeY: 245. wy = 245 - 6 = 239.
    triggerStageClick(300, 239);

    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card).toBeDefined();
    expect(card.style.display).toBe("block");

    const nameEl = card.querySelector(".agent-card-name");
    expect(nameEl?.textContent).toBe("جوني");

    const statusEl = card.querySelector(".agent-card-status");
    expect(statusEl?.textContent).toBe("🟢 شغال 85%");

    const taskEl = card.querySelector(".agent-card-task");
    expect(taskEl?.textContent).toContain("خطة استكمال الوسائط");

    const stepEl = card.querySelector(".agent-card-step");
    expect(stepEl?.textContent).toContain("تنفيذ المنطق");

    const pctEl = card.querySelector(".agent-card-percent");
    expect(pctEl?.textContent).toContain("85%");

    const nextEl = card.querySelector(".agent-card-next");
    expect(nextEl?.textContent).toContain("مراجعة أشرف");
  });

  it("case b: Click on حزلقوم (idle) -> only the name + متاح (no task, step, or next rows)", () => {
    const { evalInContext, stageWrapper, triggerStageClick } = createBoardHarness();

    evalInContext(`
      BOTS.hazalqom.status = 'idle';
      BOTS.hazalqom.name = 'حزلقوم';
      BOTS.hazalqom.progress = 0;
      effCamX = 400;
      effCamY = 270;
      cam.zoom = 1;
    `);

    // Hazalqom is at homeX: 440, homeY: 280. wy = 280 - 6 = 274.
    triggerStageClick(440, 274);

    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card).toBeDefined();
    expect(card.style.display).toBe("block");

    const nameEl = card.querySelector(".agent-card-name");
    expect(nameEl?.textContent).toBe("حزلقوم");

    const statusEl = card.querySelector(".agent-card-status");
    expect(statusEl?.textContent).toBe("☕ متاح");

    // Details rows should not exist for idle bot
    expect(card.querySelector(".agent-card-task")).toBeNull();
    expect(card.querySelector(".agent-card-step")).toBeNull();
    expect(card.querySelector(".agent-card-percent")).toBeNull();
    expect(card.querySelector(".agent-card-next")).toBeNull();
  });

  it("case c: A stuck bot -> red متأخر label with ⚠️", () => {
    const { evalInContext, stageWrapper, triggerStageClick } = createBoardHarness();

    evalInContext(`
      BOTS.salem.status = 'stuck';
      BOTS.salem.name = 'سالم';
      BOTS.salem.progress = 25;
      BOTS.salem.taskId = 'DT-123';
      effCamX = 400;
      effCamY = 270;
      cam.zoom = 1;
    `);

    // Salem is at homeX: 575, homeY: 390. wy = 390 - 6 = 384.
    triggerStageClick(70, 239);

    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card).toBeDefined();

    const statusEl = card.querySelector(".agent-card-status");
    expect(statusEl?.textContent).toBe("🔴 متأخر 25% ⚠️");
    expect(statusEl?.style.color).toBe("#ef4444");
  });

  it("case d: A task_title containing '<b>x</b>' -> shown as plain text, not as HTML", () => {
    const { evalInContext, stageWrapper, triggerStageClick } = createBoardHarness();

    evalInContext(`
      BOTS.johnny.status = 'working';
      BOTS.johnny.taskTitle = '<b>x</b>';
      BOTS.johnny.task_title = '<b>x</b>';
      BOTS.johnny.task = '<b>x</b>';
      BOTS.johnny.progress = 50;
      effCamX = 400;
      effCamY = 270;
      cam.zoom = 1;
    `);

    triggerStageClick(300, 239);

    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    const taskEl = card.querySelector(".agent-card-task");
    expect(taskEl?.textContent).toBe("المهمة: <b>x</b>");
    // Should NOT have created a <b> DOM node
    expect(card.querySelector("b")).toBeNull();
  });

  it("case e: Click on empty floor -> card closes; Esc -> card closes; click other bot -> switches", () => {
    const { evalInContext, stageWrapper, triggerStageClick, triggerKey } = createBoardHarness();

    evalInContext(`
      BOTS.johnny.status = 'working';
      BOTS.johnny.name = 'جوني';

      BOTS.nafady.status = 'working';
      BOTS.nafady.name = 'نفادي';

      effCamX = 400;
      effCamY = 270;
      cam.zoom = 1;
    `);

    // Click Johnny (300, 239) -> opens
    triggerStageClick(300, 239);
    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card.style.display).toBe("block");
    expect(card.querySelector(".agent-card-name")?.textContent).toBe("جوني");

    // Click empty space (50, 50) -> closes
    triggerStageClick(50, 50);
    expect(card.style.display).toBe("none");

    // Click Johnny again -> opens
    triggerStageClick(300, 239);
    expect(card.style.display).toBe("block");

    // Press Escape -> closes
    triggerKey("Escape");
    expect(card.style.display).toBe("none");

    // Click close button (✕) -> closes
    triggerStageClick(300, 239);
    expect(card.style.display).toBe("block");
    const closeBtn = card.querySelector(".agent-card-close");
    closeBtn?.trigger("click", { stopPropagation() {} });
    expect(card.style.display).toBe("none");

    // Click Johnny, then click Nafady (235, 144) -> switches bot
    triggerStageClick(300, 239);
    expect(card.querySelector(".agent-card-name")?.textContent).toBe("جوني");
    triggerStageClick(235, 144);
    expect(card.querySelector(".agent-card-name")?.textContent).toBe("نفادي");
  });

  it("case f: Cheer button -> bubble shows above bot and NO fetch/XHR happens", () => {
    const { evalInContext, stageWrapper, fetchCalls, triggerStageClick } = createBoardHarness();

    evalInContext(`
      BOTS.johnny.status = 'working';
      BOTS.johnny.name = 'جوني';
      effCamX = 400;
      effCamY = 270;
      cam.zoom = 1;
    `);

    triggerStageClick(300, 239);
    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    const cheerBtn = card.querySelector(".agent-card-cheer");
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

describe("DT-20261121-office-v2: Must-Pass Verification Suite", () => {
  it("Must-Pass 1 (CI Waiting Test): bot with state waiting for 2h remains waiting and displays real percent, never stuck", () => {
    const { evalInContext, stageWrapper, triggerStageClick } = createBoardHarness();

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
      effCamX = 400;
      effCamY = 270;
      cam.zoom = 1;
    `);

    expect(evalInContext("BOTS.marbouha.status")).toBe("waiting");
    expect(evalInContext("BOTS.marbouha.progress")).toBe(64);

    // Open card for Marbouha at (180, 239)
    triggerStageClick(180, 239);
    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card).toBeDefined();

    const statusEl = card.querySelector(".agent-card-status");
    expect(statusEl?.textContent).toBe("⏳ مستني 64%");
    expect(statusEl?.style.color).toBe("#38bdf8");
  });

  it("Must-Pass 2 (CTO Percent Match Test): 72% in status.md matches 72% in board and card", () => {
    const { evalInContext, stageWrapper, triggerStageClick } = createBoardHarness();

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
      effCamX = 400;
      effCamY = 270;
      cam.zoom = 1;
    `);

    expect(evalInContext("BOTS.hagras.progress")).toBe(72);

    triggerStageClick(105, 144);
    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    const pctEl = card.querySelector(".agent-card-percent");
    expect(pctEl?.textContent).toBe("الإنجاز: 72%");
  });

  it("Must-Pass 4 (Cheer Test for all 9 bots): Egyptian banter bubbles without network requests", () => {
    const { evalInContext, stageWrapper, fetchCalls, triggerStageClick } = createBoardHarness();

    const botKeys: string[] = evalInContext("BOT_KEYS");
    expect(botKeys.length).toBe(9);

    evalInContext(`
      effCamX = 400;
      effCamY = 270;
      cam.zoom = 1;
    `);

    for (const key of botKeys) {
      const bot = evalInContext(`BOTS['${key}']`);
      fetchCalls.length = 0;

      // Click on bot
      triggerStageClick(bot.homeX, bot.homeY - 6);
      const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
      expect(card.style.display).toBe("block");

      const cheerBtn = card.querySelector(".agent-card-cheer");
      expect(cheerBtn).toBeDefined();

      cheerBtn?.trigger("click", { stopPropagation() {} });

      const expectedReply = evalInContext(`CHEER_REPLIES['${key}']`);
      expect(evalInContext(`BOTS['${key}'].bubbleText`)).toBe(expectedReply);
      expect(fetchCalls.length).toBe(0);

      // Close card
      triggerStageClick(50, 50);
    }
  });

  it("Must-Pass 5 (Meeting Button Removed): #meeting-btn does not exist after load and no code path creates it", () => {
    const { evalInContext, stageWrapper } = createBoardHarness();

    const meetingBtn = stageWrapper.querySelector("#meeting-btn");
    expect(meetingBtn).toBeNull();
    expect(evalInContext("document.getElementById('meeting-btn')")).toBeNull();

    // Verify opening agent card or closing it does not create #meeting-btn
    evalInContext("openAgentCard('elkebir')");
    expect(stageWrapper.querySelector("#meeting-btn")).toBeNull();
    expect(evalInContext("document.getElementById('meeting-btn')")).toBeNull();

    evalInContext("closeAgentCard()");
    expect(stageWrapper.querySelector("#meeting-btn")).toBeNull();
    expect(evalInContext("document.getElementById('meeting-btn')")).toBeNull();

    // Trigger meeting programmatically (meeting room seats and drawing stay)
    evalInContext("triggerTeamMeeting()");
    expect(evalInContext("teamMeetingActive")).toBe(true);

    const botKeys: string[] = evalInContext("BOT_KEYS");
    for (const key of botKeys) {
      expect(evalInContext(`BOTS['${key}'].status`)).toBe("meeting");
    }

    // Simulate 5 seconds of updateWorld
    evalInContext(`
      for (let s = 0; s < 50; s++) {
        updateWorld(0.1, 1000 + s * 100);
      }
    `);

    // Verify all 9 seats in MEETING_SEATS are populated
    for (const key of botKeys) {
      const seat = evalInContext(`MEETING_SEATS['${key}']`);
      expect(seat).toBeDefined();
      expect(seat.x).toBeGreaterThanOrEqual(240);
      expect(seat.x).toBeLessThanOrEqual(485);
      expect(seat.y).toBeGreaterThanOrEqual(315);
      expect(seat.y).toBeLessThanOrEqual(540);
    }

    // End meeting
    evalInContext("endTeamMeeting()");
    expect(evalInContext("teamMeetingActive")).toBe(false);
  });

  it("Must-Pass 6 (Sleeping Gag Test): working/waiting never sleep; idle >30m sleeps; tap wakes up without modal", () => {
    const { evalInContext, stageWrapper, triggerStageClick } = createBoardHarness();

    const fortyMinsAgo = Date.now() - 40 * 60 * 1000;
    evalInContext(`
      effCamX = 400;
      effCamY = 270;
      cam.zoom = 1;

      // 1. Working bot: never sleeps
      BOTS.hagras.status = 'working';
      BOTS.hagras.updatedAt = new Date(${fortyMinsAgo}).toISOString();
      checkBotSleep(BOTS.hagras, Date.now());

      // 2. Waiting bot: never sleeps
      BOTS.marbouha.status = 'waiting';
      BOTS.marbouha.updatedAt = new Date(${fortyMinsAgo}).toISOString();
      checkBotSleep(BOTS.marbouha, Date.now());

      // 3. Idle bot > 30m: sleeps
      BOTS.salem.status = 'idle';
      BOTS.salem.updatedAt = new Date(${fortyMinsAgo}).toISOString();
      BOTS.salem.idleSince = ${fortyMinsAgo};
      checkBotSleep(BOTS.salem, Date.now());
    `);

    expect(evalInContext("BOTS.hagras.isSleeping")).toBe(false);
    expect(evalInContext("BOTS.marbouha.isSleeping")).toBe(false);
    expect(evalInContext("BOTS.salem.isSleeping")).toBe(true);

    // First click on sleeping Salem at (70, 239)
    triggerStageClick(70, 239);

    // Salem is now awake!
    expect(evalInContext("BOTS.salem.isSleeping")).toBe(false);
    // Apology bubble was shown
    const apology = evalInContext("BOTS.salem.bubbleText");
    expect(apology).toBeTruthy();
    expect(evalInContext("WAKE_APOLOGIES")).toContain(apology);

    // Modal did NOT open on first click!
    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card?.style.display || "none").toBe("none");

    // Second click on now-awake Salem opens the card!
    triggerStageClick(70, 239);
    const openedCard = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(openedCard).toBeDefined();
    expect(openedCard.style.display).toBe("block");
    expect(openedCard.querySelector(".agent-card-name")?.textContent).toBe("سالم");
  });

  it("Must-Pass 7 (DOM Security Test): zero innerHTML and safe textContent rendering", () => {
    const { evalInContext, stageWrapper, triggerStageClick } = createBoardHarness();

    const malicious = '<img src=x onerror=alert(1)>';
    evalInContext(`
      BOTS.johnny.status = 'working';
      BOTS.johnny.taskTitle = '${malicious}';
      BOTS.johnny.task_title = '${malicious}';
      BOTS.johnny.step = '${malicious}';
      BOTS.johnny.next = '${malicious}';
      BOTS.johnny.activity_type = '${malicious}';
      BOTS.johnny.progress = 50;
      effCamX = 400;
      effCamY = 270;
      cam.zoom = 1;
    `);

    triggerStageClick(290, 239);
    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector(".agent-card-task")?.textContent).toBe("المهمة: " + malicious);
    expect(card.querySelector(".agent-card-step")?.textContent).toBe("الخطوة: " + malicious);
    expect(card.querySelector(".agent-card-next")?.textContent).toBe("التالي: " + malicious);
    expect(card.querySelector(".agent-card-activity")?.textContent).toBe("النشاط: " + malicious);
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

    const { evalInContext, stageWrapper, triggerStageClick } = createBoardHarness();

    evalInContext(`
      effCamX = 400;
      effCamY = 270;
      cam.zoom = 1;
      applyLiveFeed(${JSON.stringify(feed)});
      updateWorld(0.016, 1000);
    `);

    // (a) Hazalqom: idle for 4h -> isSleeping true on first load
    expect(evalInContext("BOTS.hazalqom.isSleeping")).toBe(true);

    // Shows «نايم» in drawWorld
    evalInContext("drawWorld(ctx)");
    expect(evalInContext("BOTS.hazalqom.isSleeping")).toBe(true);

    // Tap Hazalqom to wake up -> spin + apology
    const hazalqomPos = evalInContext("getBotScreenPos(BOTS.hazalqom)");
    triggerStageClick(hazalqomPos.x, hazalqomPos.y);

    expect(evalInContext("BOTS.hazalqom.isSleeping")).toBe(false);
    expect(evalInContext("BOTS.hazalqom.wakeAnimStart")).toBeGreaterThan(0);
    const apology = evalInContext("BOTS.hazalqom.bubbleText");
    expect(apology).toBeTruthy();
    expect(evalInContext("WAKE_APOLOGIES")).toContain(apology);

    // Card popup was NOT opened on wake-up click
    const card = stageWrapper.querySelector("#agent-card-popup") as MockElement;
    expect(card?.style.display || "none").toBe("none");

    // (b) Counter: Johnny working with 4h old line -> never نايم
    expect(evalInContext("BOTS.johnny.isSleeping")).toBe(false);
    expect(evalInContext("BOTS.johnny.status")).toBe("stuck");

    // (c) Counter: Salem waiting with 4h old line -> never نايم and never «متأخر»
    expect(evalInContext("BOTS.salem.isSleeping")).toBe(false);
    expect(evalInContext("BOTS.salem.status")).toBe("waiting");
    expect(evalInContext("BOTS.salem.statusLabel")).not.toContain("متأخر");
    expect(evalInContext("BOTS.salem.statusLabel")).toContain("في الانتظار");

    // (d) Counter: Nafady with null last_active -> not sleeping on load, no crash
    expect(evalInContext("BOTS.nafady.isSleeping")).toBe(false);
    expect(evalInContext("BOTS.nafady.updatedAt")).toBeNull();
  });
});
