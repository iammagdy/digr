import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync("src/components/admin/invoices/InvoiceChatPanel.tsx", "utf8");
const builder = readFileSync("src/components/admin/invoices/InvoiceBuilder.tsx", "utf8");
const customerChat = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
const composer = readFileSync("src/app/dashboard/chat/components/Composer.tsx", "utf8");

describe("INVOICE AGENT 2, part 3: the assistant looks like Diger's customer chat", () => {
  it("uses the SAME classes as the customer chat for the user bubble, the file chip, the answer chips, the composer, the send button and the typing dots", () => {
    // user bubble and file badge, copied from the customer chat's renderNote
    for (const cls of ["rounded-[18px] bg-sf2 px-4 py-2.5 text-sm font-light leading-[1.8] text-ink", "rounded-full border border-ac/25 bg-ac/5 px-3 py-1 text-xs"]) {
      expect(customerChat, cls).toContain(cls);
      expect(panel, cls).toContain(cls);
    }
    // the assistant's own text is plain (no bubble), 15px light with a double line height, like the customer chat's
    expect(customerChat).toContain("text-[15px] font-light leading-[2] text-ink");
    expect(panel).toContain("text-[15px] font-light leading-[2] text-ink");
    // answer chips: the customer chat's pill
    expect(customerChat).toContain("rounded-full border border-ln2 bg-sf px-4 py-2 text-xs font-semibold text-ink hover:bg-sf2");
    expect(panel).toContain("rounded-full border border-ln2 bg-sf px-4 py-2 text-xs font-semibold text-ink");
    // the composer pill and the round send button
    expect(composer).toContain("rounded-full border border-ln bg-sf");
    expect(panel).toContain("rounded-full border border-ln bg-sf p-1.5");
    expect(composer).toContain("rounded-full border-0 bg-ac text-onac");
    expect(panel).toContain("rounded-full border-0 bg-ac text-onac");
    // the typing indicator: the same three moving dots
    expect(panel).toContain("run-dot h-1.5 w-1.5 rounded-full bg-ac");
    expect(panel).toContain('animation: "up .3s both"');
  });

  it("is phone-first: full height on a phone, 44 px targets, nothing wider than the screen; beside the live preview from the large breakpoint", () => {
    expect(panel).toContain("h-[calc(100dvh-150px)]");
    expect(panel).toContain("min-h-11");
    expect(panel).toContain("overflow-x-hidden");
    expect(panel).toContain("lg:h-[min(720px,calc(100dvh-160px))]");
    expect(builder).toContain("lg:grid-cols-2"); // the chat is in the first column, the preview in the second
    expect(builder.indexOf("<InvoiceChatPanel")).toBeLessThan(builder.indexOf("{preview}")); // the preview is rendered in the SECOND column of the grid
  });

  it("has no emoji, no middle dot (it reads as the Arabic zero), and shows file names as a stem plus a separate extension badge (a mixed Arabic + number + .xlsx name is reordered by bidi)", () => {
    expect(panel).not.toMatch(/(?![©®™])\p{Extended_Pictographic}/u);
    expect(panel).not.toContain("·");
    expect(panel).toContain("const stemOf");
    expect(panel).toContain("<Ext name=");
    expect(panel).not.toMatch(/<bdi dir="ltr"[^>]*>\{[a-z.]*(file|name|f)\b/i);
  });
});

describe("INVOICE AGENT 2, part 2: the conversation is wired", () => {
  it("after the files are counted the assistant asks one question at a time, with chips and (where it takes an amount, a rate or a name) its own small input", () => {
    for (const id of ["agent-question", "agent-answer-input", "agent-answer-send", "agent-answer-error", "agent-summary", "agent-summary-text", "agent-details", "agent-departments", "agent-people", "agent-move-to-person", "agent-move-to-department", "agent-duplicates", "agent-columns"]) expect(panel, id).toContain(`data-testid="${id}"`);
    expect(panel).toContain("data-testid={`agent-chip-${c.value}`}");
    expect(panel).toContain("nextQuestion(");
    expect(panel).toContain("buildFlowActions(");
    expect(panel).toContain("prefillFromActions(");
    expect(panel).toContain("answerChip(");
    expect(panel).toContain("answerText(");
    expect(panel).toContain("moveContact(");
  });

  it("the questions come from CODE (flow.ts), not from the model: the panel does not call the model again after the files, and every answer is local", () => {
    expect(panel).toMatch(/if \(r\.count\) \{[\s\S]*?advance\(a\);[\s\S]*?return;/);
    expect(panel).toContain("local: true");
    expect(panel).toContain("filter((m) => !m.error && !m.local && !m.ask)"); // chip answers and questions never go back to the model
  });

  it("an unmapped sheet with data is put to the owner («أحسبها؟»), never skipped silently", () => {
    expect(panel).toContain("ما اتحسبتش");
    expect(panel).toContain('{ label: "احسبها", value: "map" }');
    expect(panel).toContain('{ label: "سيبها", value: "skip" }');
  });

  it("the final draft is shown with the total before and after and waits for «تمام»; only then does the form change, and every step can be undone", () => {
    expect(panel).toContain("تمام. ده اللي هبنيه في المسودة، راجعه وقل تمام:");
    expect(panel).toContain('data-testid="agent-confirm"');
    expect(panel).toContain("doUndo");
  });

  it("nothing is saved and nothing is sent from the chat", () => {
    expect(panel).not.toMatch(/\/status|method: "PUT"|onSave|askSend|changeStatus/);
    expect([...panel.matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1])).toEqual(["/api/admin/invoices/agent"]);
  });
});
