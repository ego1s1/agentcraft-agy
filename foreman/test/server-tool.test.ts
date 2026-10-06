import http from "node:http";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../src/context.js";
import { ForemanServer } from "../src/server.js";

describe("ForemanServer HTTP API", () => {
  it("handles /health and /api/tool", async () => {
    const mockFm = {
      subscribe: () => () => {},
      executeTool: async (agentId: string, tool: string, args: Record<string, unknown>) => {
        return { text: `Executed ${tool} for ${agentId} with ${JSON.stringify(args)}` };
      },
    } as any;

    const server = new ForemanServer(mockFm, {
      host: "127.0.0.1",
      port: 0,
      log: silentLogger,
    });

    const port = await server.start();

    // 1. Check /health
    const healthRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      }).on("error", reject);
    });

    expect(healthRes.status).toBe(200);
    expect(JSON.parse(healthRes.body).status).toBe("ok");

    // 2. Check /api/tool
    const toolPayload = JSON.stringify({
      agentId: "kit",
      tool: "report_status",
      args: { activity: "testing" },
    });

    const toolRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/tool",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(toolPayload),
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode!, body }));
        },
      );
      req.on("error", reject);
      req.write(toolPayload);
      req.end();
    });

    expect(toolRes.status).toBe(200);
    const parsed = JSON.parse(toolRes.body);
    expect(parsed.text).toContain("Executed report_status for kit");

    await server.stop();
  });
});
