import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { decideTurn } from "../src/lib/agentMission/conversationModel";
import { classifyMessage } from "../src/lib/agentMission/messageType";

describe("N16 Routing: remove keyword overrule & platform lists", () => {
  it("decideTurn does NOT override model decision (service_question or other) when keywords match collectible data", async () => {
    const fakeModel = async () => ({
      ok: true as const,
      text: JSON.stringify({ type: "service_question", reply: "نعم نوفر بيانات فيسبوك بأسعار محددة", reason: "سؤال عن الخدمة" }),
    });

    const ctx = {
      message: "أنا عايز أعرف طريقة جمع تعليقات فيسبوك والأسعار",
      balancePoints: 100,
    } as any;

    const res = await decideTurn(ctx, fakeModel);
    expect(res.type).toBe("service_question");
    expect((res as any).overruled).toBeUndefined();
  });

  it("fallback classifyMessage classifies requests outside old 5-platform list as data_request structurally", () => {
    const examples = [
      "عايز ٢٠٠ منتج جملة من 1688 عن إكسسوارات الموبايل",
      "هات أسعار إغلاق سهم أبل آخر شهر من البورصة",
      "عايز قائمة المشاكل المفتوحة في مستودع جيت هب",
    ];

    for (const msg of examples) {
      expect(classifyMessage(msg), `Expected "${msg}" to be data_request`).toBe("data_request");
    }
  });

  it("src/lib/agentMission/messageType.ts contains no platform name regex or specific platform lists", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/lib/agentMission/messageType.ts"), "utf8");
    expect(src).not.toMatch(/PLATFORM_NAME_RE/);
    expect(src).not.toMatch(/tiktok\|تيك توك/);
  });
});
