import * as http from "http";

export interface FakeTregServerInstance {
  server: http.Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startFakeTregServer(port: number = 4040): Promise<FakeTregServerInstance> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const testScenario = req.headers["x-test-scenario"] as string;

      // Common CORS and JSON headers
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");

      // Scenario 1: Route Max Cost Cap hit (402 route_max_cost)
      if (testScenario === "route_max_cost") {
        res.setHeader("X-Treg-Call-Id", `call_mock_cap_${Date.now()}`);
        res.setHeader("X-Treg-Cost-Micro", "0");
        res.setHeader("X-Treg-Latency-Ms", "45");
        res.writeHead(402);
        res.end(
          JSON.stringify({
            error: "route_max_cost",
            message: "Estimated or actual cost exceeded route cost ceiling",
          })
        );
        return;
      }

      // Scenario 2: Platform low balance (402 insufficient_balance)
      if (testScenario === "insufficient_balance") {
        res.setHeader("X-Treg-Call-Id", `call_mock_bal_${Date.now()}`);
        res.setHeader("X-Treg-Cost-Micro", "0");
        res.setHeader("X-Treg-Latency-Ms", "30");
        res.writeHead(402);
        res.end(
          JSON.stringify({
            error: "insufficient_balance",
            message: "Account credits exhausted. Please top up your TREG balance.",
          })
        );
        return;
      }

      // Scenario 3: Upstream Rate Limit (429)
      if (testScenario === "rate_limit") {
        res.setHeader("X-Treg-Call-Id", `call_mock_429_${Date.now()}`);
        res.setHeader("X-Treg-Cost-Micro", "0");
        res.writeHead(429);
        res.end(
          JSON.stringify({
            error: "rate_limit_exceeded",
            message: "Too many requests. Please throttle.",
          })
        );
        return;
      }

      // Scenario 4: Upstream Provider 500 error
      if (testScenario === "upstream_error") {
        res.setHeader("X-Treg-Call-Id", `call_mock_500_${Date.now()}`);
        res.setHeader("X-Treg-Cost-Micro", "0");
        res.writeHead(502);
        res.end(
          JSON.stringify({
            error: "provider_unavailable",
            message: "Upstream source returned HTTP 500",
          })
        );
        return;
      }

      // Scenario 5: Normal TikTok Profile Response (200 OK)
      const usernameParam = url.searchParams.get("uniqueId") || url.searchParams.get("username") || "mock_user";

      res.setHeader("X-Treg-Call-Id", `call_mock_ok_${Date.now()}`);
      res.setHeader("X-Treg-Cost-Micro", "1200"); // 1200 microUSD = $0.0012
      res.setHeader("X-Treg-Latency-Ms", "115");
      res.writeHead(200);

      const mockResponse = {
        code: 0,
        msg: "success",
        data: {
          user: {
            id: "72194820194820194",
            uniqueId: usernameParam,
            nickname: `TikTok Creator (${usernameParam})`,
            avatarLarger: `https://p16-sign.tiktokcdn.com/${usernameParam}_avatar.jpeg`,
            signature: "Digital content creator • Exploring data scraping with Diger",
            verified: true,
            secUid: "MS4wLjABAAAAk39f_1...",
            region: "EG",
          },
          stats: {
            followerCount: 182400,
            followingCount: 340,
            heartCount: 4210000,
            videoCount: 78,
            diggCount: 450,
          },
        },
      };

      res.end(JSON.stringify(mockResponse));
    });

    server.listen(port, () => {
      const actualPort = (server.address() as any).port;
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        close: () =>
          new Promise((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });

    server.on("error", reject);
  });
}

// Standalone execution support
if (require.main === module) {
  const port = parseInt(process.env.PORT || "4040", 10);
  startFakeTregServer(port).then((inst) => {
    console.log(`🚀 Fake TREG Server listening on ${inst.url}`);
    console.log("Press Ctrl+C to stop.");
  });
}
