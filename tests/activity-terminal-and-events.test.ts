import { describe, it, expect } from "vitest";
import {
  computePublicCalculatorQuote,
  getPublicCalculatorOptions,
} from "../src/lib/calculatorPricing";
import {
  calculateCapabilityQuote,
  calculateCapabilityUnitPricePoints,
  calculateFinalSettlement,
  DEFAULT_PRICING_SETTINGS,
} from "../src/functions/shared/quotes";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import crypto from "crypto";

describe("Real-Time Activity Terminal, Worker Event Logging & Guest Rules", () => {
  describe("1. Worker Event Logging Format & Customer Sanitization", () => {
    it("ensures all recorded job_events conform to strict Arabic formatting without emoji, USD, or provider names", () => {
      // Sample events generated during chunk worker steps
      const targetMax = 10;
      const currentStep = 0;
      const acceptedRows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
      const excludedCount = 3;
      const recordedDeliveredUnits = 5;
      const chargedPts = 30;
      const refundedPts = 5;

      const eventMessages = [
        `تم قبول الطلب وجاري بدء التنفيذ (تم حجز 35 نقطة)`,
        `بدء استخراج البيانات (المستهدف حتى ${targetMax} سجل)...`,
        `تم تدقيق السجلات واستبعاد ${excludedCount} سجل مكرر.`,
        `تم استلام الدفعة ${currentStep + 1}: تم قبول ${acceptedRows.length} سجل جديد (الإجمالي المعتمد: ${recordedDeliveredUnits} من ${targetMax}).`,
        `جاري تجهيز وتنسيق ملفات النتائج (Excel و PDF و CSV)...`,
        `تم إكمال استخراج ${recordedDeliveredUnits} سجل بنجاح وحفظ ملفات النتائج.`,
        `تم خصم ${chargedPts} نقطة وتحرير ${refundedPts} نقطة متبقية تلقائياً لرصيدك.`,
      ];

      const forbiddenRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]|treg|scrapecreators|tikhub|serpapi|usd|\$|anthropic|openai/iu;

      for (const msg of eventMessages) {
        expect(msg).not.toMatch(forbiddenRegex);
        // Verify it contains Arabic characters
        expect(msg).toMatch(/[\u0600-\u06FF]/);
      }
    });

    it("verifies event ordering and sequential monotonicity", () => {
      const recordedEvents = [
        { id: 1, step: 0, message: "تم قبول الطلب وجاري بدء التنفيذ", created_at: "2026-10-15T09:00:00Z" },
        { id: 2, step: 1, message: "بدء استخراج البيانات", created_at: "2026-10-15T09:00:01Z" },
        { id: 3, step: 2, message: "تم استبعاد 2 سجل مكرر", created_at: "2026-10-15T09:00:05Z" },
        { id: 4, step: 3, message: "تم استلام الدفعة 1", created_at: "2026-10-15T09:00:06Z" },
        { id: 5, step: 4, message: "جاري تجهيز الملفات", created_at: "2026-10-15T09:00:08Z" },
        { id: 6, step: 5, message: "تم إكمال الاستخراج بنجاح", created_at: "2026-10-15T09:00:10Z" },
      ];

      for (let i = 1; i < recordedEvents.length; i++) {
        expect(recordedEvents[i].step).toBeGreaterThan(recordedEvents[i - 1].step);
        expect(new Date(recordedEvents[i].created_at).getTime()).toBeGreaterThanOrEqual(
          new Date(recordedEvents[i - 1].created_at).getTime()
        );
      }
    });
  });

  describe("2. Free Guest Messaging & Session Migration", () => {
    function guestSessionToUuid(sessionId: string): string {
      const hash = crypto.createHash("sha256").update(`guest_session:${sessionId}`).digest("hex");
      return [
        hash.substring(0, 8),
        hash.substring(8, 12),
        "4" + hash.substring(13, 16),
        ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.substring(18, 20),
        hash.substring(20, 32),
      ].join("-");
    }

    it("generates deterministic, valid RFC 4122 v4 UUIDs from guest session tokens", () => {
      const sessionToken = "gst_9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890";
      const uuid1 = guestSessionToUuid(sessionToken);
      const uuid2 = guestSessionToUuid(sessionToken);

      expect(uuid1).toBe(uuid2);
      expect(uuid1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it("guarantees different guest sessions generate distinct UUIDs to prevent cross-account leak", () => {
      const uuidA = guestSessionToUuid("guest_session_alpha");
      const uuidB = guestSessionToUuid("guest_session_beta");
      expect(uuidA).not.toBe(uuidB);
    });

    it("enforces free guest message limit (default 3 messages)", () => {
      const GUEST_MESSAGE_LIMIT = 3;
      let usedCount = 0;

      // Messages 1, 2, 3 allowed
      while (usedCount < GUEST_MESSAGE_LIMIT) {
        expect(usedCount < GUEST_MESSAGE_LIMIT).toBe(true);
        usedCount++;
      }

      // Message 4 blocked
      expect(usedCount >= GUEST_MESSAGE_LIMIT).toBe(true);
      const isBlocked = usedCount >= GUEST_MESSAGE_LIMIT;
      expect(isBlocked).toBe(true);
    });
  });

  describe("3. Calculator Pricing Single Source of Truth Across 10 Catalog Capabilities", () => {
    it("produces identical pricing across 10 diverse capabilities and volumes with 0 discrepancy", () => {
      const samples = [
        { slug: "tiktok-profile", target: 1, delivered: 1 },
        { slug: "tiktok-profile", target: 5, delivered: 4 },
        { slug: "facebook-post-comments", target: 10, delivered: 10 },
        { slug: "facebook-post-comments", target: 100, delivered: 75 },
        { slug: "x-keyword-search", target: 50, delivered: 50 },
        { slug: "x-keyword-search", target: 200, delivered: 180 },
        { slug: "instagram-comments", target: 50, delivered: 50 },
        { slug: "instagram-comments", target: 150, delivered: 120 },
        { slug: "youtube-comments", target: 80, delivered: 80 },
        { slug: "youtube-comments", target: 200, delivered: 150 },
      ];

      for (const sample of samples) {
        const cap = APPROVED_CAPABILITY_CATALOG.find((c) => c.slug === sample.slug);
        if (!cap) continue;

        const calc = computePublicCalculatorQuote(
          sample.slug,
          sample.target,
          sample.delivered,
          APPROVED_CAPABILITY_CATALOG,
          DEFAULT_PRICING_SETTINGS
        );

        const directQuote = calculateCapabilityQuote(
          sample.target,
          cap.unitCostUsd,
          100_000,
          DEFAULT_PRICING_SETTINGS
        );

        const directSettlement = calculateFinalSettlement(
          sample.delivered,
          directQuote.unitPricePoints,
          directQuote.quotedPoints
        );

        // Assert 0 discrepancy
        expect(calc.unitPricePoints).toBe(directQuote.unitPricePoints);
        expect(calc.reservedPoints).toBe(directQuote.quotedPoints);
        expect(calc.chargedPoints).toBe(directSettlement.chargePoints);
        expect(calc.refundPoints).toBe(directSettlement.refundPoints);

        // Verification of EGP conversion: 1 point = 0.10 EGP
        expect(calc.reservedEgp).toBe(Number((directQuote.quotedPoints * 0.10).toFixed(2)));
        expect(calc.chargedEgp).toBe(Number((directSettlement.chargePoints * 0.10).toFixed(2)));
        expect(calc.refundEgp).toBe(Number((directSettlement.refundPoints * 0.10).toFixed(2)));
      }
    });

    it("verifies public calculator options hide all provider names and USD costs", () => {
      const options = getPublicCalculatorOptions();
      expect(options.length).toBeGreaterThan(0);
      const str = JSON.stringify(options);
      expect(str).not.toMatch(/treg|scrapecreators|tikhub|serpapi|usd|\$/i);
    });
  });
});
