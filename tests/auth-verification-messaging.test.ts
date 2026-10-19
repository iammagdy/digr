import { describe, expect, it } from "vitest";
import { authErrorMessage } from "../src/lib/authMessages";

describe("unconfirmed signup login feedback", () => {
  it("explains how to resolve an unconfirmed email login", () => {
    expect(authErrorMessage({ code: "email_not_confirmed" }, "generic login error")).toContain("لم يتم تأكيد البريد الإلكتروني بعد");
    expect(authErrorMessage({ message: "Email not confirmed" }, "generic login error")).toContain("أعد إرسالها");
  });
});
