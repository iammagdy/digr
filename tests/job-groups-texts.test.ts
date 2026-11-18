import { describe, it, expect } from "vitest";
import * as copy from "../src/lib/multiProvider/copy";
import { GROUP_UNAVAILABLE_AR, GROUP_OPERATOR_CLOSE_AR, GROUP_PART_STOPPED_AR, GROUP_PART_FILE_PENDING_AR, GROUP_PART_FILE_UNAVAILABLE_AR, GROUP_PARTS_TITLE_AR, GROUP_PARTS_UNAVAILABLE_AR, GROUP_PART_UNFROZEN_RELEASED_AR, GROUP_CLOSING_NOTICE_AR, NEUTRAL_STOP_REASON_AR } from "../src/lib/multiProvider/copy";
import { checkCustomerText } from "../src/lib/agentMission/text";

describe("DT-05 PR-3 group texts", () => {
  it.each([
    ["NEUTRAL_STOP_REASON_AR", NEUTRAL_STOP_REASON_AR, "السبب: لم يصلنا سبب محدد لتوقف المعالجة قبل اكتمال العدد."],
    ["GROUP_UNAVAILABLE_AR", GROUP_UNAVAILABLE_AR, "تعذّر بدء الطلب المقسَّم الآن، ولم يُحجز أي شيء. حاول مرة أخرى بعد قليل."],
    ["GROUP_OPERATOR_CLOSE_AR", GROUP_OPERATOR_CLOSE_AR, "أوقفنا الأجزاء الباقية من هذا الطلب من جانبنا."],
    ["GROUP_PART_STOPPED_AR", GROUP_PART_STOPPED_AR, "أوقفنا هذا الجزء من الطلب قبل اكتماله، ولم يُخصم عنه شيء، وما حُجز له حجز مؤقت مُحرَّر."],
    ["GROUP_PART_FILE_PENDING_AR", GROUP_PART_FILE_PENDING_AR, "ملف هذا الجزء قيد التجهيز ولم يُتح للتحميل بعد. حاول مرة أخرى لاحقًا."],
    ["GROUP_PART_FILE_UNAVAILABLE_AR", GROUP_PART_FILE_UNAVAILABLE_AR, "تعذّر تحميل ملف هذا الجزء الآن. حاول مرة أخرى لاحقًا."],
    ["GROUP_PARTS_TITLE_AR", GROUP_PARTS_TITLE_AR, "أجزاء هذا الطلب"],
    ["GROUP_PARTS_UNAVAILABLE_AR", GROUP_PARTS_UNAVAILABLE_AR, "تعذّر تحميل روابط أجزاء هذا الطلب الآن. حاول مرة أخرى لاحقًا."],
    ["GROUP_PART_UNFROZEN_RELEASED_AR", GROUP_PART_UNFROZEN_RELEASED_AR, "تعذّر تجهيز ملف هذا الجزء بأمان، فلم نحتسبه من المسلَّم ولم يُخصم عنه شيء، وما حُجز له حجز مؤقت مُحرَّر."],
    ["GROUP_CLOSING_NOTICE_AR", GROUP_CLOSING_NOTICE_AR, "انتهت المدة المتاحة لتنفيذ طلبك، ونعمل الآن على إيقاف الجزء الجاري وإنهاء الطلب. تبقى النقاط محجوزة حتى ذلك الحين، ولن يُخصم منها إلا ثمن ما سُلِّم فعلًا."],
  ] as Array<[string, string, string]>)("%s is the plan's exact text and passes checkCustomerText", (_name, actual, expected) => {
    expect(actual).toBe(expected);
    expect(checkCustomerText(actual).issues).toEqual([]);
  });

  it("GROUP_PART_STOPPED_AR gives no time or deadline reason, because the operator stop uses it too", () => {
    for (const word of ["المدة", "٧٢ ساعة", "لتجاوزه"]) expect(GROUP_PART_STOPPED_AR).not.toContain(word);
  });

  it("splitCardLineAr writes C1 when Y = X", () => {
    expect(copy.splitCardLineAr({ parts: 3, perPart: 40, reachable: 120, askedOriginal: 120, hold: 1200 })).toBe("طلبت ١٢٠ شركة، وأقصى ما تتسع له المهمة الواحدة ٤٠ شركة بسبب الحد الأقصى لحجز المهمة الواحدة، لذلك سننفّذ طلبك على ٣ أجزاء متتالية تلقائيًا بموافقة واحدة منك. عند موافقتك نحجز ١٢٠٠ نقطة مرة واحدة لكل الأجزاء، ولا يُخصم منها إلا ثمن ما يُسلَّم فعلًا، والباقي حجز مؤقت مُحرَّر عند انتهاء الطلب. لن نسلّمك الشركة نفسها مرتين.");
  });
  it("splitCardLineAr writes C1b when Y < X (the 40-part limit)", () => {
    expect(copy.splitCardLineAr({ parts: 40, perPart: 40, reachable: 1600, askedOriginal: 2000, hold: 6000 })).toBe("طلبت ٢٠٠٠ شركة، وأقصى ما تتسع له المهمة الواحدة ٤٠ شركة بسبب الحد الأقصى لحجز المهمة الواحدة، وأقصى عدد أجزاء للطلب الواحد ٤٠، لذلك أقصى ما يمكن تسليمه في هذا الطلب ١٦٠٠ شركة على ٤٠ أجزاء متتالية تلقائيًا بموافقة واحدة منك. عند موافقتك نحجز ٦٠٠٠ نقطة مرة واحدة لكل الأجزاء، ولا يُخصم منها إلا ثمن ما يُسلَّم فعلًا، والباقي حجز مؤقت مُحرَّر عند انتهاء الطلب. لن نسلّمك الشركة نفسها مرتين.");
  });
  it("groupStartLineAr is S1", () => { expect(copy.groupStartLineAr({ hold: 1200, parts: 3 })).toBe("تمت الموافقة على طلبك كاملًا وحُجزت ١٢٠٠ نقطة مرة واحدة. بدأ الجزء ١ من ٣، وستبدأ الأجزاء التالية تلقائيًا بعد انتهاء كل جزء، وفي صفحة تفاصيل أي جزء من الطلب تجد روابط كل أجزائه."); });
  it("groupDrawLineAr is S2", () => { expect(copy.groupDrawLineAr({ k: 2, K: 3, Z: 40, Y: 120 })).toBe("انتهى الجزء ١ من ٣، والمسلَّم حتى الآن ٤٠ من ١٢٠. بدأ الجزء ٢ تلقائيًا من الحجز الذي وافقت عليه، دون حجز جديد."); });
  it("groupPartLinkAr is S16", () => { expect(copy.groupPartLinkAr(2, 3)).toBe("الجزء ٢ من ٣"); });
  it.each([copy.splitCardLineAr({ parts: 3, perPart: 40, reachable: 120, askedOriginal: 120, hold: 1200 }), copy.splitCardLineAr({ parts: 40, perPart: 40, reachable: 1600, askedOriginal: 2000, hold: 6000 }), copy.groupStartLineAr({ hold: 1200, parts: 3 }), copy.groupDrawLineAr({ k: 2, K: 3, Z: 40, Y: 120 }), copy.groupPartLinkAr(2, 3)])("text %# passes checkCustomerText", (t) => { expect(checkCustomerText(t).issues).toEqual([]); });

  it.each([
    ["all_parts_done", { reason: "all_parts_done", Z: 120, X: 120, Y: 120, C: 1200 }, "المسلَّم ١٢٠ من ١٢٠ مطلوب. الخصم الإجمالي ١٢٠٠ نقطة، والباقي حجز مؤقت مُحرَّر."],
    ["all_parts_done", { reason: "all_parts_done", Z: 1600, X: 2000, Y: 1600, C: 6000 }, "المسلَّم ١٦٠٠ من ٢٠٠٠ مطلوب. السبب: أقصى ما يتسع له الطلب الواحد ١٦٠٠ شركة على ٤٠ جزءًا، ويمكنك طلب الباقي في طلب جديد. الخصم الإجمالي ٦٠٠٠ نقطة، والباقي حجز مؤقت مُحرَّر."],
    ["all_parts_done", { reason: "all_parts_done", Z: 100, X: 120, Y: 120, C: 1000 }, "المسلَّم ١٠٠ من ١٢٠ مطلوب. السبب: لم يصلنا سبب محدد لتوقف المعالجة قبل اكتمال العدد. الخصم الإجمالي ١٠٠٠ نقطة، والباقي حجز مؤقت مُحرَّر."],
    ["deadline", { reason: "deadline", Z: 40, X: 120, Y: 120, C: 400 }, "المسلَّم ٤٠ من ١٢٠ مطلوب. السبب: انتهت المدة المتاحة لتنفيذ الطلب (٧٢ ساعة) قبل اكتمال الأجزاء. الخصم الإجمالي ٤٠٠ نقطة، والباقي حجز مؤقت مُحرَّر."],
    ["deadline_stuck", { reason: "deadline_stuck", Z: 40, X: 120, Y: 120, C: 400 }, "المسلَّم ٤٠ من ١٢٠ مطلوب. السبب: انتهت المدة المتاحة لتنفيذ الطلب (٧٢ ساعة) قبل اكتمال الأجزاء. الخصم الإجمالي ٤٠٠ نقطة، والباقي حجز مؤقت مُحرَّر."],
    ["empty_parts", { reason: "empty_parts", Z: 40, X: 120, Y: 120, C: 400 }, "المسلَّم ٤٠ من ١٢٠ مطلوب. السبب: لم يُسلَّم شيء في جزأين متتاليين، فأوقفنا الأجزاء الباقية. الخصم الإجمالي ٤٠٠ نقطة، والباقي حجز مؤقت مُحرَّر."],
    ["part_unfrozen", { reason: "part_unfrozen", Z: 40, X: 120, Y: 120, C: 0 }, "المسلَّم ٤٠ من ١٢٠ مطلوب. السبب: تعذّر تجهيز ملف جزء من الطلب بأمان، فلم نحتسبه من المسلَّم ولم يُخصم عنه شيء، وأوقفنا الأجزاء الباقية. الخصم الإجمالي ٠ نقطة، والباقي حجز مؤقت مُحرَّر."],
  ] as Array<[string, { reason: copy.GroupCloseReason; Z: number; X: number; Y: number; C: number }, string]>)("groupFinalLineAr %s (Z=%#)", (_r, args, expected) => {
    expect(copy.groupFinalLineAr(args)).toBe(expected);
    expect(checkCustomerText(expected).issues).toEqual([]);
  });
  it("a delivered-in-full request has no reason clause", () => { expect(copy.groupFinalLineAr({ reason: "all_parts_done", Z: 120, X: 120, Y: 120, C: 1200 })).not.toContain("السبب"); });

  const PROVIDER = /treg|tomba|icypeas|firecrawl|context\.?dev|hunter|apollo|blitz|aviato|enrichlayer|serp|reoon/i;
  const S5_ARGS = [{ reason: "all_parts_done", Z: 120, X: 120, Y: 120, C: 1200 }, { reason: "all_parts_done", Z: 1600, X: 2000, Y: 1600, C: 6000 }, { reason: "all_parts_done", Z: 100, X: 120, Y: 120, C: 1000 }, { reason: "deadline", Z: 40, X: 120, Y: 120, C: 400 }, { reason: "deadline_stuck", Z: 40, X: 120, Y: 120, C: 400 }, { reason: "empty_parts", Z: 40, X: 120, Y: 120, C: 400 }, { reason: "part_unfrozen", Z: 40, X: 120, Y: 120, C: 0 }] as const;
  const NEW_TEXTS: string[] = [copy.NEUTRAL_STOP_REASON_AR, copy.GROUP_UNAVAILABLE_AR, copy.GROUP_OPERATOR_CLOSE_AR, copy.GROUP_PART_STOPPED_AR, copy.GROUP_PART_FILE_PENDING_AR, copy.GROUP_PART_FILE_UNAVAILABLE_AR, copy.GROUP_PARTS_TITLE_AR, copy.GROUP_PARTS_UNAVAILABLE_AR, copy.GROUP_PART_UNFROZEN_RELEASED_AR, copy.GROUP_CLOSING_NOTICE_AR, copy.splitCardLineAr({ parts: 3, perPart: 40, reachable: 120, askedOriginal: 120, hold: 1200 }), copy.splitCardLineAr({ parts: 40, perPart: 40, reachable: 1600, askedOriginal: 2000, hold: 6000 }), copy.groupStartLineAr({ hold: 1200, parts: 3 }), copy.groupDrawLineAr({ k: 2, K: 3, Z: 40, Y: 120 }), copy.groupPartLinkAr(2, 3), ...S5_ARGS.map((a) => copy.groupFinalLineAr(a))];
  it("every group text is in ALL_CUSTOMER_STRINGS, passes the customer-text guard and names no provider", () => {
    const all = copy.ALL_CUSTOMER_STRINGS();
    for (const t of NEW_TEXTS) { expect(all).toContain(t); expect(checkCustomerText(t).issues, t).toEqual([]); expect(t).not.toMatch(PROVIDER); }
  });
  it("no new group text contains «زر» (there is no button in this feature)", () => {
    expect(NEW_TEXTS.length).toBe(22);
    for (const t of NEW_TEXTS) expect(t).not.toContain("زر");
  });
  it("S3 is not exported: the group/split exports are exactly the plan's list", () => {
    expect(Object.keys(copy).filter((k) => /group|split/i.test(k)).sort()).toEqual(["GROUP_CLOSING_NOTICE_AR", "GROUP_OPERATOR_CLOSE_AR", "GROUP_PARTS_TITLE_AR", "GROUP_PARTS_UNAVAILABLE_AR", "GROUP_PART_FILE_PENDING_AR", "GROUP_PART_FILE_UNAVAILABLE_AR", "GROUP_PART_STOPPED_AR", "GROUP_PART_UNFROZEN_RELEASED_AR", "GROUP_UNAVAILABLE_AR", "groupDrawLineAr", "groupFinalLineAr", "groupPartLinkAr", "groupStartLineAr", "splitCardLineAr"]);
  });
});
