import { describe, it, expect } from "vitest";
import * as copy from "../src/lib/multiProvider/copy";
import { GROUP_UNAVAILABLE_AR, GROUP_OPERATOR_CLOSE_AR, GROUP_PART_STOPPED_AR, GROUP_PART_FILE_PENDING_AR, GROUP_PART_FILE_UNAVAILABLE_AR, GROUP_PARTS_TITLE_AR, GROUP_PARTS_UNAVAILABLE_AR, GROUP_PART_UNFROZEN_RELEASED_AR, GROUP_CLOSING_NOTICE_AR, NEUTRAL_STOP_REASON_AR } from "../src/lib/multiProvider/copy";
import { checkCustomerText } from "../src/lib/agentMission/text";

describe("DT-05 PR-3 group texts", () => {
  it.each([
    ["NEUTRAL_STOP_REASON_AR", NEUTRAL_STOP_REASON_AR, "السبب: لم يصلنا سبب محدد لتوقف المعالجة قبل اكتمال العدد."],
    ["GROUP_UNAVAILABLE_AR", GROUP_UNAVAILABLE_AR, "تعذّر بدء الطلب المقسَّم الآن، ولم يُحجز أي شيء. حاول مرة أخرى بعد قليل."],
    ["GROUP_OPERATOR_CLOSE_AR", GROUP_OPERATOR_CLOSE_AR, "أوقفنا الأجزاء الباقية من هذا الطلب من جانبنا."],
    ["GROUP_PART_STOPPED_AR", GROUP_PART_STOPPED_AR, "أوقفنا هذا الجزء من الطلب لتجاوزه المدة المتاحة، ولم يُخصم عنه شيء، وحُرِّر حجزه."],
    ["GROUP_PART_FILE_PENDING_AR", GROUP_PART_FILE_PENDING_AR, "ملف هذا الجزء قيد التجهيز ولم يُتح للتحميل بعد. حاول مرة أخرى لاحقًا."],
    ["GROUP_PART_FILE_UNAVAILABLE_AR", GROUP_PART_FILE_UNAVAILABLE_AR, "تعذّر تحميل ملف هذا الجزء الآن. حاول مرة أخرى لاحقًا."],
    ["GROUP_PARTS_TITLE_AR", GROUP_PARTS_TITLE_AR, "أجزاء هذا الطلب"],
    ["GROUP_PARTS_UNAVAILABLE_AR", GROUP_PARTS_UNAVAILABLE_AR, "تعذّر تحميل روابط أجزاء هذا الطلب الآن. حاول مرة أخرى لاحقًا."],
    ["GROUP_PART_UNFROZEN_RELEASED_AR", GROUP_PART_UNFROZEN_RELEASED_AR, "تعذّر تجهيز ملف هذا الجزء بأمان، فلم نحتسبه من المسلَّم ولم يُخصم عنه شيء، وحُرِّر حجزه."],
    ["GROUP_CLOSING_NOTICE_AR", GROUP_CLOSING_NOTICE_AR, "انتهت المدة المتاحة لتنفيذ طلبك، ونعمل الآن على إيقاف الجزء الجاري وإنهاء الطلب. تبقى النقاط محجوزة حتى ذلك الحين، ولن يُخصم منها إلا ثمن ما سُلِّم فعلًا."],
  ] as Array<[string, string, string]>)("%s is the plan's exact text and passes checkCustomerText", (_name, actual, expected) => {
    expect(actual).toBe(expected);
    expect(checkCustomerText(actual).issues).toEqual([]);
  });
});
