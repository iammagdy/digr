import { customerMissionView } from "../../src/lib/agentMission/customerView";
const plan = {
  summary_ar: "ستستلم ملف إكسل بـ ٥٠ تغريدة عن «القهوة» خلال آخر ٣ أشهر، مع تاريخ كل تغريدة ونصها ورابطها.",
  assumptions_ar: [
    "المقصود: تغريدات عامة عن القهوة بالعربية خلال آخر ٣ أشهر.",
    "المقصود تغريدات عامة عن القهوة بالعربية خلال آخر ٣ أشهر",
    "الردود لا تُحتسب ضمن العدد المطلوب.",
  ],
  notes_ar: [],
  stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: "x.search", expected_rows: 50, planned_rows: 50, parent_key: null, deliver: true,
    columns: [{ key: "createdAt", title_ar: "التاريخ والوقت" }, { key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "الرابط" }, { key: "author", title_ar: "الكاتب" }],
    sample_rows: [
      { createdAt: "2026-10-30T21:59:00.000Z", text: "أحلى فنجان قهوة في الصباح مع أصحابي في وسط البلد، والجو جميل جدًا النهاردة", url: "https://x.com/user1/status/1", author: "محمد أحمد" },
      { createdAt: "2026-10-29T08:15:30.000Z", text: "القهوة التركي أحسن من الإسبريسو بالنسبة لي", url: "https://x.com/user2/status/2", author: "سارة" },
      { createdAt: "2026-10-28T12:00:00.000Z", text: "جربت مكان جديد للقهوة المختصة", url: "https://x.com/user3/status/3", author: "علي" },
    ] }],
  price: { max_charge_points: 200, reserve_points: 230 },
  expected_minutes: 2,
};
const base = { id: "m1", question_ar: null, reserved_points: 230, unit_price_points: 4, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: new Date(Date.now() - 60000).toISOString() };
const q = { ahead: 0, running: 0, workerAlive: true };
const out = {
  plan: customerMissionView({ mission: { ...base, status: "plan_ready", plan_public: plan }, events: [], queue: q }),
  planning: customerMissionView({ mission: { ...base, status: "planning", plan_public: null, reserved_points: null }, events: [{ id: 1, kind: "progress", message_ar: "بنفهم طلبك", counts: { samples: 2, stages: 3 }, created_at: new Date().toISOString() }], callsMade: 2, queue: q }),
  running: customerMissionView({ mission: { ...base, status: "executing", plan_public: plan }, events: [{ id: 1, kind: "progress", message_ar: "بدأنا", counts: { stage: 1, saved: 12 }, created_at: new Date().toISOString() }], queue: q, emailWillBeSent: true }),
};
console.log(JSON.stringify(out));
