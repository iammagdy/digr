import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFetchError, REQUEST_REFUSED_AR, apiFetch, safeApiPath } from "../src/lib/apiFetch";
import { ChatRequestError, TEMPORARY_FAILURE_AR, TEMPORARY_FAILURE_NO_CHARGE_AR, customerFacingFailure, isRetryableFailure } from "../src/lib/customerError";

const noToken = async () => "";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** What a customer would read: Arabic, no Latin letters (no «Failed to fetch», no «not_found», no ids). */
function expectCustomerText(text: string) {
  expect(text).toMatch(/[؀-ۿ]/);
  expect(text).not.toMatch(/[A-Za-z]/);
}

async function failureOf(call: Promise<unknown>): Promise<ApiFetchError> {
  const err = await call.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ApiFetchError);
  return err as ApiFetchError;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("apiFetch: every failure is one Arabic sentence", () => {
  it("a platform error page (HTML 502) is the temporary sentence, not «Unexpected token <»", async () => {
    stubFetch(async () => new Response("<!DOCTYPE html><html><body>Bad Gateway</body></html>", { status: 502, headers: { "Content-Type": "text/html" } }));
    const err = await failureOf(apiFetch("/api/x", { getAccessToken: noToken }));
    expect(err.message).toBe(TEMPORARY_FAILURE_AR);
    expect(err.text).toBe(err.message);
    expect(err.status).toBe(502);
    expect(err.code).toBe("server:bad_response");
    expect(err.retryable).toBe(true);
    expectCustomerText(err.message);
  });

  it("an HTML 504 with the no-charge flag says nothing was charged", async () => {
    stubFetch(async () => new Response("<html>An error occurred</html>", { status: 504 }));
    const err = await failureOf(apiFetch("/api/chat", { getAccessToken: noToken, noCharge: true }));
    expect(err.message).toBe(TEMPORARY_FAILURE_NO_CHARGE_AR);
    expectCustomerText(err.message);
  });

  it("a broken JSON body on a 200 is a failure too, never a thrown SyntaxError", async () => {
    stubFetch(async () => new Response("{\"success\": tru", { status: 200 }));
    const err = await failureOf(apiFetch("/api/x", { getAccessToken: noToken }));
    expect(err.message).toBe(TEMPORARY_FAILURE_AR);
    expect(err.code).toBe("server:bad_response");
  });

  it("an English message from the server is replaced by the Arabic sentence", async () => {
    stubFetch(async () => json({ success: false, error: "Internal Server Error: relation \"jobs\" does not exist" }, 500));
    const err = await failureOf(apiFetch("/api/x", { getAccessToken: noToken }));
    expect(err.message).toBe(TEMPORARY_FAILURE_AR);
    expectCustomerText(err.message);

    stubFetch(async () => json({ success: false, error: "Unauthorized" }, 401));
    const unauthorized = await failureOf(apiFetch("/api/x", { getAccessToken: noToken }));
    expectCustomerText(unauthorized.message);
  });

  it("a clean Arabic sentence the server wrote for a 4xx passes through", async () => {
    const wait = "تم تجاوز الحد الأقصى المؤقت للطلبات. يرجى الانتظار دقيقة والمحاولة مجدداً.";
    stubFetch(async () => json({ success: false, error: wait, reason: "rate_limit_exceeded" }, 429));
    const err = await failureOf(apiFetch("/api/x", { getAccessToken: noToken }));
    expect(err.message).toBe(wait);
    expect(err.status).toBe(429);
    expect(err.reason).toBe("rate_limit_exceeded");
  });

  it("a dropped connection («Failed to fetch», Safari's «Load failed») is the temporary sentence", async () => {
    for (const message of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) {
      stubFetch(async () => { throw new TypeError(message); });
      const err = await failureOf(apiFetch("/api/x", { getAccessToken: noToken }));
      expect(err.message).toBe(TEMPORARY_FAILURE_AR);
      expect(err.code).toBe("network");
      expect(err.retryable).toBe(true);
      expect(err.message).not.toContain(message);
    }
  });

  it("a request that never answers ends at the timeout with the temporary sentence", async () => {
    vi.useFakeTimers();
    let sawAbort = false;
    stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => { sawAbort = true; reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })); });
    }));
    const pending = failureOf(apiFetch("/api/x", { getAccessToken: noToken, timeoutMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(5_000);
    const err = await pending;
    expect(sawAbort).toBe(true);
    expect(err.message).toBe(TEMPORARY_FAILURE_AR);
    expect(err.code).toBe("client_timeout");
    expect(err.aborted).toBe(false);
    expectCustomerText(err.message);
  });

  it("an explicit `not_found` / `bad_request` code is permanent: Arabic, no retry", async () => {
    const bodies: Array<() => Response> = [
      () => json({ success: false, error: "not_found" }, 404),
      () => json({ success: false, error: "bad_request" }, 400),
      () => json({ success: false, error: "حدث خطأ", reason: "not_found" }, 404),
    ];
    for (const make of bodies) {
      stubFetch(async () => make());
      const err = await failureOf(apiFetch("/api/missions/abc", { getAccessToken: noToken }));
      expectCustomerText(err.message);
      expect(err.retryable).toBe(false);
      expect(err.message).not.toContain("جرّب مرة أخرى");
      expect(err.message).not.toContain("تعثر مؤقت");
    }
    stubFetch(async () => json({ success: false, error: "not_found" }, 404));
    expect((await failureOf(apiFetch("/api/x", { getAccessToken: noToken }))).message).toBe("العنصر المطلوب غير موجود أو لم يعد متاحًا.");
  });

  it("a 404 WITHOUT an explicit code stays temporary and retryable: an HTML page, an empty body, a proxy answer, English text", async () => {
    const bodies: Array<() => Response> = [
      () => new Response("<html>404 Not Found</html>", { status: 404, headers: { "Content-Type": "text/html" } }),
      () => new Response("", { status: 404 }),
      () => json({}, 404),
      () => json({ success: false, error: "Not Found" }, 404),
      () => json({ success: false, error: "route_missing" }, 404),
    ];
    for (const make of bodies) {
      stubFetch(async () => make());
      const err = await failureOf(apiFetch("/api/x", { getAccessToken: noToken }));
      expect(err.retryable).toBe(true);
      expect(err.message).toBe(TEMPORARY_FAILURE_AR);
      expect(err.reason).not.toBe("not_found");
      expectCustomerText(err.message);
    }
  });

  it("a 5xx whose body carries a code-like word stays temporary and retryable (only `not_found` / `bad_request` on a 4xx count)", async () => {
    for (const [status, error] of [[500, "internal_error"], [503, "unavailable"], [502, "bad_gateway"], [500, "not_found"], [500, "bad_request"]] as const) {
      stubFetch(async () => json({ success: false, error }, status));
      const err = await failureOf(apiFetch("/api/x", { getAccessToken: noToken }));
      expect(err.retryable).toBe(true);
      expect(err.message).toBe(TEMPORARY_FAILURE_AR);
    }
    // a 4xx with some other code-like word is not read as a reason either
    stubFetch(async () => json({ success: false, error: "forbidden_thing" }, 403));
    const other = await failureOf(apiFetch("/api/x", { getAccessToken: noToken }));
    expect(other.reason).toBe("");
    expect(other.retryable).toBe(true);
  });
});

describe("apiFetch: the token only ever goes to our own /api/ routes", () => {
  const refused = [
    "https://evil.example/api/x",
    "http://evil.example/api/x",
    "//evil.example/api/x",
    "///evil.example/api/x",
    "/\\evil.example/api/x",
    "/api/\\..\\..\\x",
    "javascript:alert(1)",
    "data:text/plain,x",
    "ftp://evil.example/api/x",
    "mailto:a@b.c",
    "api/x",
    "/",
    "/other",
    "/apix/y",
    "/api",
    "/api/../x",
    "/api/../../x",
    "/api/%2e%2e/x",
    "/api/%2E%2E/%2e%2e/x",
    "/api/x/../../y",
    "/api/\t/../../x",
    "/api/x\n.evil",
    "",
    "   /api/x",
  ];

  it("refuses every one of them with an Arabic sentence: no fetch, no token read, no Authorization header", async () => {
    for (const path of refused) {
      const mock = stubFetch(async () => json({ success: true }));
      const getAccessToken = vi.fn(async () => "SECRET-TOKEN");
      const err = await failureOf(apiFetch(path, { getAccessToken }));
      expect(mock, path).not.toHaveBeenCalled();
      expect(getAccessToken, path).not.toHaveBeenCalled();
      expect(err.message, path).toBe(REQUEST_REFUSED_AR);
      expect(err.code).toBe("bad_path");
      expect(err.retryable).toBe(false);
      expect(err.status).toBe(0);
      expectCustomerText(err.message);
    }
  });

  it("refuses a non-string address too", async () => {
    for (const path of [undefined, null, 5, {}, ["/api/x"]]) {
      const mock = stubFetch(async () => json({ success: true }));
      const getAccessToken = vi.fn(async () => "SECRET-TOKEN");
      await failureOf(apiFetch(path as unknown as string, { getAccessToken }));
      expect(mock).not.toHaveBeenCalled();
      expect(getAccessToken).not.toHaveBeenCalled();
    }
  });

  it("allows our own routes, and sends the RESOLVED path, never the raw text", async () => {
    const mock = stubFetch(async () => json({ success: true }));
    await apiFetch("/api/wallet/balance", { getAccessToken: async () => "tok" });
    await apiFetch("/api/jobs/abc/data?x=1&y=%D8%B9", { getAccessToken: async () => "tok" });
    await apiFetch("/api/a/./b/../c", { getAccessToken: async () => "tok" });
    expect(mock.mock.calls.map((c) => c[0])).toEqual(["/api/wallet/balance", "/api/jobs/abc/data?x=1&y=%D8%B9", "/api/a/c"]);
    for (const call of mock.mock.calls) expect((call[1].headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("safeApiPath returns the resolved same-origin path, or null", () => {
    expect(safeApiPath("/api/x?y=1")).toBe("/api/x?y=1");
    expect(safeApiPath("/api/x#frag")).toBe("/api/x");
    expect(safeApiPath("https://evil.example/api/x")).toBeNull();
    expect(safeApiPath("//evil.example/api/x")).toBeNull();
    expect(safeApiPath("/api/../x")).toBeNull();
  });

  it("a redirect is never followed (`redirect: \"error\"`), so the header cannot go to another host; the failure is the Arabic temporary sentence", async () => {
    // the real fetch rejects with a TypeError when `redirect: "error"` meets a redirect: nothing is read from the other host
    const mock = stubFetch(async (_url, init) => {
      if (init.redirect === "error") throw new TypeError("Failed to fetch");
      return new Response(null, { status: 302, headers: { Location: "https://evil.example/steal" } });
    });
    const err = await failureOf(apiFetch("/api/x", { getAccessToken: async () => "SECRET-TOKEN" }));
    expect(mock).toHaveBeenCalledTimes(1);
    const init = mock.mock.calls[0][1];
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("same-origin");
    expect(mock.mock.calls[0][0]).toBe("/api/x");
    expect(err.message).toBe(TEMPORARY_FAILURE_AR);
    expectCustomerText(err.message);
  });

  it("a caller cannot turn the redirect guard or the credentials mode off", async () => {
    const mock = stubFetch(async () => json({ success: true }));
    await apiFetch("/api/x", { getAccessToken: noToken, redirect: "follow", credentials: "include" });
    const init = mock.mock.calls[0][1];
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("same-origin");
  });

  it("the Authorization header appears only on the allowed call, never on a refused one (one fetch in total)", async () => {
    const mock = stubFetch(async () => json({ success: true }));
    const getAccessToken = async () => "SECRET-TOKEN";
    await failureOf(apiFetch("https://evil.example/api/x", { getAccessToken }));
    await apiFetch("/api/ok", { getAccessToken });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toBe("/api/ok");
  });
});

describe("apiFetch: the request itself", () => {
  it("returns the JSON on success, with and without a `success` field, and sends the token and a JSON body", async () => {
    const mock = stubFetch(async () => json({ success: true, rows: [1, 2] }));
    await expect(apiFetch("/api/x", { method: "POST", body: { a: 1 }, getAccessToken: async () => "tok123" })).resolves.toEqual({ success: true, rows: [1, 2] });
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("/api/x");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok123");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe("{\"a\":1}");

    stubFetch(async () => json({ entries: [] }));
    await expect(apiFetch("/api/admin/audit", { getAccessToken: noToken })).resolves.toEqual({ entries: [] });
  });

  it("sends no Authorization header when there is no session, and a failed token read does not fail the call", async () => {
    const mock = stubFetch(async () => json({ success: true }));
    await apiFetch("/api/x", { getAccessToken: noToken });
    await apiFetch("/api/x", { getAccessToken: async () => { throw new Error("storage blocked"); } });
    for (const call of mock.mock.calls) expect((call[1].headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("a FormData body keeps its own multipart type", async () => {
    const mock = stubFetch(async () => json({ success: true }));
    await apiFetch("/api/x", { method: "POST", body: new FormData(), getAccessToken: noToken });
    expect((mock.mock.calls[0][1].headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("a page that closed (the caller's signal) is flagged so it can stay silent, and is not reported as a timeout", async () => {
    // like the real fetch: an already-aborted signal rejects at once, a later abort rejects when it happens
    stubFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort);
    }));
    const controller = new AbortController();
    const pending = failureOf(apiFetch("/api/x", { getAccessToken: noToken, signal: controller.signal }));
    controller.abort();
    const err = await pending;
    expect(err.aborted).toBe(true);
    expectCustomerText(err.message);
  });

  it("the fallback sentence for a balance-touching call is used instead of the no-charge one", async () => {
    stubFetch(async () => { throw new TypeError("Failed to fetch"); });
    const err = await failureOf(apiFetch("/api/x", { getAccessToken: noToken, fallback: "تعذر إتمام العملية الآن." }));
    expect(err.message).toBe("تعذر إتمام العملية الآن.");
  });
});

describe("customerFacingFailure: permanent reasons", () => {
  it("not_found and bad_request are not retryable and read as Arabic even when the server sent only the English code", () => {
    for (const reason of ["not_found", "bad_request"]) {
      const err = new ChatRequestError(reason, reason === "not_found" ? 404 : 400, reason);
      expect(isRetryableFailure(err)).toBe(false);
      const { text } = customerFacingFailure(err);
      expectCustomerText(text);
      expect(text).not.toBe(TEMPORARY_FAILURE_AR);
    }
  });

  it("the chat's own sentence for a missing conversation (reason `not_found`, written in Arabic by the server) is shown unchanged; only its retry offer is gone", () => {
    const err = new ChatRequestError("المحادثة المطلوبة غير موجودة.", 404, "not_found");
    expect(customerFacingFailure(err, { noCharge: true }).text).toBe("المحادثة المطلوبة غير موجودة.");
    expect(isRetryableFailure(err)).toBe(false);
  });

  it("a `not_found` with no reason and no code (a bare 404 from a proxy) keeps the temporary sentence and the retry offer", () => {
    const err = new ChatRequestError("", 404, "bad_response");
    expect(isRetryableFailure(err)).toBe(true);
    expect(customerFacingFailure(err).text).toBe(TEMPORARY_FAILURE_AR);
  });

  it("other reasons keep their behaviour: a 5xx is still temporary and retryable", () => {
    const err = new ChatRequestError("", 500, "internal_error");
    expect(isRetryableFailure(err)).toBe(true);
    expect(customerFacingFailure(err).text).toBe(TEMPORARY_FAILURE_AR);
  });
});
