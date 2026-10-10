import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FakeTregFetcher, FakeTregRequest, FakeTregPage } from "../../src/functions/shared/dependentPlans";

export interface FakeTregFixtureOptions {
  failUsers?: string[];
  cursorLoop?: boolean;
}

export interface FakeTregFixtureServer {
  url: string;
  requests: FakeTregRequest[];
  fetchPage: FakeTregFetcher;
  close: () => Promise<void>;
}

function respond(response: ServerResponse, status: number, body: FakeTregPage): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readRequest(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Starts an ephemeral loopback-only HTTP server; it never calls a real data provider. */
export async function startFakeTregFixtureServer(options: FakeTregFixtureOptions = {}): Promise<FakeTregFixtureServer> {
  const requests: FakeTregRequest[] = [];
  const failed = new Set((options.failUsers || []).map((user) => user.toLowerCase()));
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/execute") {
      respond(response, 404, { ok: false, rows: [], errorCode: "route_not_found" });
      return;
    }
    let body: FakeTregRequest;
    try {
      body = await readRequest(request) as FakeTregRequest;
      requests.push(body);
    } catch {
      respond(response, 400, { ok: false, rows: [], errorCode: "invalid_json" });
      return;
    }

    if (body.capabilitySlug === "fixture-account-discovery") {
      if (body.params.mode === "cursor_loop" && options.cursorLoop) {
        respond(response, 200, {
          ok: true,
          rows: body.cursor ? [{ entityType: "account", username: "loop_account" }] : [{ entityType: "account", username: "loop_account" }],
          nextCursor: body.cursor ? "loop_cursor" : "loop_cursor",
        });
        return;
      }
      respond(response, 200, {
        ok: true,
        rows: [
          { entityType: "account", id: "acct-noura", username: "noura", displayName: "نورا" },
          { entityType: "account", id: "acct-karim", username: "karim", displayName: "كريم" },
          { entityType: "account", id: "acct-salma", username: "salma", displayName: "سلمى" },
        ],
        nextCursor: null,
      });
      return;
    }

    if (body.capabilitySlug === "fixture-account-videos") {
      const username = String(body.params.username || "").toLowerCase();
      if (failed.has(username)) {
        respond(response, 503, { ok: false, rows: [], errorCode: "fixture_branch_failure" });
        return;
      }
      const windowKey = body.window?.from || "all";
      if (!body.cursor) {
        respond(response, 200, {
          ok: true,
          rows: [{ entityType: "video", videoId: "video-shared", username, window: windowKey, title: "مقطع مشترك" }],
          nextCursor: `page2_${username}`,
        });
        return;
      }
      respond(response, 200, {
        ok: true,
        rows: [{ entityType: "video", videoId: `video-${username}-${windowKey}`, username, window: windowKey, title: `مقطع ${username}` }],
        nextCursor: null,
      });
      return;
    }

    respond(response, 404, { ok: false, rows: [], errorCode: "unknown_fixture_capability" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/execute`;
  const fetchPage: FakeTregFetcher = async (payload) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    return await response.json() as FakeTregPage;
  };
  return {
    url,
    requests,
    fetchPage,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
