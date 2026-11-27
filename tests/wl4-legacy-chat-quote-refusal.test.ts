import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POST } from "../src/app/api/chat/[retiredQuoteAction]/route";
import { checkCustomerText } from "../src/lib/agentMission/text";

describe("D-0248 stale chat quotes", () => {
  it.each(["accept-quote", "edit-plan", "sample-remainder"])(
    "returns the retirement error for an old browser POST to %s",
    async (action) => {
      const request = new Request(`http://localhost/api/chat/${action}`, {
        method: "POST",
        body: "not JSON",
      });
      const response = await POST(request, { params: Promise.resolve({ retiredQuoteAction: action }) });
      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body).toEqual({ success: false, error: "العرض ده قديم ومبقاش متاح، اكتب طلبك من جديد" });
      expect(checkCustomerText(body.error)).toEqual({ issues: [], text: body.error });
      expect(request.bodyUsed).toBe(false);
      expect(existsSync(`src/app/api/chat/${action}/route.ts`)).toBe(false);
      expect(readFileSync("src/app/dashboard/chat/page.tsx", "utf8")).not.toContain(`/api/chat/${action}`);
    },
  );

  it("keeps unrelated chat actions unavailable", async () => {
    const retiredQuoteAction = "unregistered";
    const request = new Request("http://localhost/api/chat/unregistered", { method: "POST" });
    const response = await POST(request, { params: Promise.resolve({ retiredQuoteAction }) });
    expect(response.status).toBe(404);
  });
});
