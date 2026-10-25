import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  notifs: [] as any[],
  emails: [] as any[],
  ledgerRows: [] as any[],
}));

const createMockSdk = vi.hoisted(() => () => {
  class MockClient { setEndpoint() { return this; } setProject() { return this; } setKey() { return this; } }
  class Users {
    async get() { return { name: "أحمد محمد علي", email: "a@example.com", prefs: {} }; }
  }
  class Messaging { async createEmail(args: any) { db.emails.push(args); } }
  class TablesDB {
    async createRow(a: any) { db.notifs.push(a); return { $id: a.rowId }; }
    async listRows({ tableId }: any) {
      if (tableId === "credit_ledger") return { rows: db.ledgerRows };
      return { rows: [] };
    }
  }
  return {
    Client: MockClient, Users, TablesDB, Messaging,
    ID: { unique: () => "id1" },
    Permission: { read: (r: string) => `read(${r})`, update: (r: string) => `update(${r})` },
    Role: { user: (u: string) => `user:${u}`, label: (l: string) => `label:${l}` },
    Query: {
      equal: (f: string, v: any) => `equal(${f},${JSON.stringify(v)})`,
      limit: (n: number) => `limit(${n})`,
      offset: (n: number) => `offset(${n})`,
    },
  };
});

vi.mock("node-appwrite", createMockSdk);
vi.mock("../src/functions/shared/dbCompat", createMockSdk);

import { renderEmailTemplate, formatArabicDate } from "../src/functions/shared/emailTemplates";
import { notifyUser, notifyJobOutcome } from "../src/functions/shared/notify";

const client = new (class { setEndpoint() { return this; } setProject() { return this; } setKey() { return this; } })() as any;

describe("renderEmailTemplate (branded platform emails)", () => {
  it("renders welcome with the subject, logo and substituted Name", () => {
    const { subject, html } = renderEmailTemplate("welcome", { Name: "أحمد" });
    expect(subject).toBe("أهلًا أحمد — حسابك على ديجر جاهز");
    expect(html).toContain("https://diger.tech/email/digr-wordmark.png");
    expect(html).toContain("أهلًا أحمد");
    expect(html).not.toContain("{{");
  });

  it("renders every template with full vars and no leftover tokens", () => {
    const full: Record<string, Record<string, string>> = {
      welcome: { Name: "أحمد" },
      "topup-received": { AmountEgp: "١٠٠", CreatedAt: "١٣ أكتوبر ٢٠٢٦", Credits: "١٠٠٠", Reference: "R1" },
      "topup-approved": { ConfirmedAmountEgp: "٢٥٠", Credits: "٢٥٠٠", Reference: "R1", Balance: "٣٠٠٠" },
      "topup-rejected": { AmountEgp: "١٠٠", Reference: "R1", RejectReason: "المبلغ مختلف" },
      "job-done": { Charged: "٨٠", Delivered: "١٠", Refunded: "٢٠", Requested: "١٠٠", JobTitle: "استخراج ملف حساب تيك توك العام", JobURL: "https://diger.tech/dashboard/requests" },
      refund: { Points: "٢٠", Reason: "فرق الحجز", JobTitle: "استخراج ملف حساب تيك توك العام", Balance: "٣٠٠٠" },
    };
    for (const [id, vars] of Object.entries(full)) {
      const { subject, html } = renderEmailTemplate(id as any, vars);
      expect(subject, `${id} subject`).not.toContain("{{");
      expect(html, `${id} html`).not.toContain("{{");
      expect(html, `${id} logo`).toContain("email/digr-wordmark.png");
    }
  });

  it("HTML-escapes substituted values in the body but not in the plain-text subject", () => {
    const { subject, html } = renderEmailTemplate("welcome", { Name: "<b>أحمد</b>" });
    expect(html).toContain("&lt;b&gt;أحمد&lt;/b&gt;");
    expect(html).not.toContain("<b>أحمد</b>");
    expect(subject).toContain("<b>أحمد</b>");
  });

  it("renders missing variables as empty, never leaking raw tokens", () => {
    const { subject, html } = renderEmailTemplate("refund", {});
    expect(subject).toBe("حجز مؤقت مُحرَّر بقيمة  نقطة");
    expect(html).not.toContain("{{");
  });

  it("defaults SiteURL to the canonical domain", () => {
    const { html } = renderEmailTemplate("welcome", { Name: "أحمد" });
    expect(html).toContain("https://diger.tech/email/digr-wordmark.png");
  });

  it("formatArabicDate renders an Arabic date", () => {
    expect(formatArabicDate("2026-10-13T12:00:00.000Z")).toBe("13 أكتوبر 2026");
  });
});

describe("notifyUser sends the branded template (not the old plain HTML)", () => {
  beforeEach(() => {
    db.notifs = [];
    db.emails = [];
    db.ledgerRows = [{ delta: 50 }, { delta: -10 }];
  });

  it("topup_approved uses the branded subject/html and fills Balance from the ledger", async () => {
    await notifyUser(client, {
      userId: "u1", kind: "topup_approved", title: "تم اعتماد شحن رصيدك", body: "x", link: "/dashboard/topup",
      emailVars: { ConfirmedAmountEgp: "٢٥٠", Credits: "٢٥٠٠", Reference: "R1" },
    });
    expect(db.notifs).toHaveLength(1);
    expect(db.notifs[0].data.kind).toBe("topup_approved");
    expect(db.emails).toHaveLength(1);
    expect(db.emails[0].subject).toBe("أُضيف ٢٥٠٠ نقطة إلى رصيدك");
    expect(db.emails[0].content).toContain("email/digr-wordmark.png");
    expect(db.emails[0].content).toContain("R1");
    expect(db.emails[0].content).toContain("٤٠"); // Balance = 50 - 10
    expect(db.emails[0].content).not.toContain("{{");
  });

  it("topup_received uses the received template", async () => {
    await notifyUser(client, {
      userId: "u1", kind: "topup_received", title: "تم استلام طلب الشحن", body: "x", link: "/dashboard/topup",
      emailVars: { AmountEgp: "١٠٠", CreatedAt: "١٣ أكتوبر ٢٠٢٦", Credits: "١٠٠٠", Reference: "R1" },
    });
    expect(db.emails).toHaveLength(1);
    expect(db.emails[0].subject).toBe("استلمنا طلب شحن ١٠٠ ج.م");
    expect(db.emails[0].content).toContain("R1");
  });

  it("job_done + refund emails carry the job title and points", async () => {
    await notifyJobOutcome(client, "u1", {
      status: "done", deliveredUnits: 10, chargedCredits: 80, refundCredits: 20,
      jobTitle: "استخراج ملف حساب تيك توك العام", requestedUnits: 100,
    });
    expect(db.emails).toHaveLength(2);
    expect(db.emails[0].subject).toContain("استخراج ملف حساب تيك توك العام");
    expect(db.emails[0].content).toContain("استخراج ملف حساب تيك توك العام");
    expect(db.emails[1].subject).toBe("حجز مؤقت مُحرَّر بقيمة ٢٠ نقطة");
  });

  it("failed jobs send a single refund email", async () => {
    await notifyJobOutcome(client, "u1", {
      status: "failed", reservedCredits: 50, jobTitle: "استخراج ملف حساب تيك توك العام",
    });
    expect(db.emails).toHaveLength(1);
    expect(db.emails[0].subject).toBe("حجز مؤقت مُحرَّر بقيمة ٥٠ نقطة");
  });
});
