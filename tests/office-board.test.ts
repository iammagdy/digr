import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

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

  const elements = new Map<string, any>();
  const mockCtx: any = {
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
      // Realistic mock: 5.5px per character
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

  const makeEl = (tag = "div", id = "") => ({
    id,
    tagName: tag.toUpperCase(),
    style: {} as Record<string, string>,
    className: "",
    textContent: "",
    src: "",
    clientWidth: 800,
    clientHeight: 450,
    addEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 800, height: 450 };
    },
    getContext() {
      return mockCtx;
    },
  });

  elements.set("stage-wrapper", makeEl("div", "stage-wrapper"));
  elements.set("office-canvas", makeEl("canvas", "office-canvas"));

  const sandbox: any = {
    window: {} as any,
    document: {
      getElementById(id: string) {
        return elements.get(id) ?? null;
      },
      addEventListener() {},
    },
    innerWidth: 800,
    innerHeight: 450,
    devicePixelRatio: 1,
    matchMedia() {
      return { matches: false };
    },
    Image: class {
      src = "";
      complete = false;
      naturalWidth = 0;
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
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
  sandbox.window = sandbox;

  const vmCtx = vm.createContext(sandbox);
  vm.runInContext(script, vmCtx);

  const evalInContext = (code: string) => vm.runInContext(code, vmCtx);

  return { vmCtx, mockCtx, fillTextCalls, evalInContext };
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

    // Slot 0 geometry
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

    // Generous availWidth where full title fits
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
    // Context direction is restored after drawWalls
    expect(mockCtx.direction).toBe("ltr");
  });
});
