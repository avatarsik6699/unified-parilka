import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LoopbackMcpServer } from "../src/mcp-loopback.js";
import type { ParilkaToolRegistry } from "../src/mcp-protocol.js";

test(
  "loopback rejects a second request when a session is at its in-flight limit",
  { timeout: 10_000 },
  async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const owner = new LoopbackMcpServer({
      registry: waitRegistry(markStarted),
      testPort: 0,
      maxActiveRequestsPerSession: 1,
    });
    const url = await owner.start();
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client(
      { name: "loopback-inflight-limit-test", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      const request = new AbortController();
      const first = client.callTool(
        { name: "wait_for_cancel", arguments: {} },
        undefined,
        { signal: request.signal, timeout: 120_000 },
      );
      await started;
      const sessionId = (
        transport as unknown as { _sessionId?: string }
      )._sessionId;
      if (typeof sessionId !== "string") {
        throw new Error("MCP transport did not expose a session ID.");
      }
      const second = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId,
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "wait_for_cancel",
            arguments: {},
          },
        }),
      });
      assert.equal(second.status, 429);
      assert.match(await second.text(), /in-flight|capacity/iu);
      request.abort(new DOMException("finish first request", "AbortError"));
      await assert.rejects(first);
    } finally {
      await client.close();
      await owner.close();
    }
  },
);

function waitRegistry(markStarted: () => void): ParilkaToolRegistry {
  return {
    listTools() {
      return [
        {
          name: "wait_for_cancel",
          description: "Wait until the request is cancelled.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ];
    },
    async callTool(name, _rawArgs, options) {
      assert.equal(name, "wait_for_cancel");
      markStarted();
      const signal = options?.signal;
      if (signal && !signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
      throw new DOMException("Tool observed cancellation.", "AbortError");
    },
  };
}
