import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  LoopbackMcpServer,
  parseLoopbackMcpEndpoint,
} from "../src/mcp-loopback.js";
import type { BotToolRegistry } from "../src/mcp-protocol.js";

test("loopback endpoint parser rejects remote, credentialed, and ambiguous URLs", () => {
  assert.equal(
    parseLoopbackMcpEndpoint(
      "http://127.0.0.1:8766/mcp",
    ).url.href,
    "http://127.0.0.1:8766/mcp",
  );

  for (const value of [
    "https://127.0.0.1:8766/mcp",
    "http://0.0.0.0:8766/mcp",
    "http://localhost:8766/mcp",
    "http://user:secret@127.0.0.1:8766/mcp",
    "http://127.0.0.1:8766/other",
    "http://127.0.0.1:8766/mcp?token=secret",
    "http://127.0.0.1/mcp",
  ]) {
    assert.throws(
      () => parseLoopbackMcpEndpoint(value),
      /BOT_MCP_HTTP_URL/u,
      value,
    );
  }
});

test("importing the proxy entrypoint does not load Telegram credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "parilka-proxy-env-"));
  const envPath = join(directory, "shared.env");
  const marker = "proxy-must-not-load-this-session";
  try {
    writeFileSync(envPath, `TELEGRAM_SESSION=${marker}\n`);
    const env = { ...process.env };
    delete env.TELEGRAM_SESSION;
    delete env.TELEGRAM_SESSION_STRING;
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        [
          `process.env.TELEGRAM_SHARED_ENV_PATH=${JSON.stringify(envPath)};`,
          "await import('./src/index.ts');",
          "process.stdout.write(process.env.TELEGRAM_SESSION === undefined ? 'unset' : 'set');",
        ].join(""),
      ],
      {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "unset");
    assert.doesNotMatch(child.stderr, new RegExp(marker, "u"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("session-scoped loopback MCP serves one canonical tool registry", async () => {
  const owner = new LoopbackMcpServer({
    registry: echoRegistry(),
    testPort: 0,
    onError(error) {
      throw error;
    },
  });
  const url = await owner.start();
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client(
    { name: "loopback-test", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map(({ name }) => name),
      ["echo_safe"],
    );
    const called = await client.callTool({
      name: "echo_safe",
      arguments: { value: "safe payload" },
    });
    assert.deepEqual(called.content, [
      { type: "text", text: "safe payload" },
    ]);

    const wrongOrigin = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
      }),
    });
    assert.equal(wrongOrigin.status, 403);

    const unsupported = await fetch(url);
    assert.equal(unsupported.status, 405);
  } finally {
    await client.close();
    await owner.close();
  }
  assert.equal(owner.running, false);
});

test(
  "loopback owner propagates MCP cancellation into the tool registry",
  { timeout: 10_000 },
  async () => {
    const lifecycle = cancellationLifecycle();
    const owner = new LoopbackMcpServer({
      registry: cancellableRegistry(lifecycle),
      testPort: 0,
    });
    const url = await owner.start();
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client(
      { name: "loopback-cancellation-test", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      const request = new AbortController();
      const pending = client.callTool(
        {
          name: "wait_for_cancel",
          arguments: {},
        },
        undefined,
        {
          signal: request.signal,
          timeout: 120_000,
        },
      );
      await lifecycle.started;
      request.abort(
        new DOMException("cancel owner request", "AbortError"),
      );

      await assert.rejects(pending);
      await lifecycle.cancelled;
      assert.equal(lifecycle.observedSignal?.aborted, true);
    } finally {
      await client.close();
      await owner.close();
    }
  },
);

test(
  "loopback sessions have a hard cap, idle expiry, and explicit cleanup",
  { timeout: 5_000 },
  async () => {
    const owner = new LoopbackMcpServer({
      registry: echoRegistry(),
      testPort: 0,
      maxSessions: 1,
      sessionIdleTimeoutMs: 200,
    });
    const url = await owner.start();
    const firstTransport =
      new StreamableHTTPClientTransport(url);
    const first = new Client(
      { name: "session-bound-first", version: "1.0.0" },
      { capabilities: {} },
    );
    const rejectedTransport =
      new StreamableHTTPClientTransport(url);
    const rejected = new Client(
      { name: "session-bound-rejected", version: "1.0.0" },
      { capabilities: {} },
    );
    let replacement:
      | {
          client: Client;
          transport: StreamableHTTPClientTransport;
        }
      | undefined;
    try {
      await first.connect(firstTransport);
      assert.equal(owner.activeSessionCount, 1);
      await assert.rejects(
        rejected.connect(rejectedTransport),
        /503|capacity/iu,
      );
      assert.equal(owner.activeSessionCount, 1);

      // Client.close() intentionally simulates an ungraceful peer: the HTTP
      // session stays server-side until the bounded idle reaper removes it.
      await first.close();
      await waitFor(() => owner.activeSessionCount === 0);

      const replacementTransport =
        new StreamableHTTPClientTransport(url);
      const replacementClient = new Client(
        {
          name: "session-bound-replacement",
          version: "1.0.0",
        },
        { capabilities: {} },
      );
      replacement = {
        client: replacementClient,
        transport: replacementTransport,
      };
      await replacementClient.connect(replacementTransport);
      assert.equal(owner.activeSessionCount, 1);

      await replacementTransport.terminateSession();
      await waitFor(() => owner.activeSessionCount === 0);
    } finally {
      await rejected.close().catch(() => undefined);
      await first.close().catch(() => undefined);
      await replacement?.client.close().catch(() => undefined);
      await owner.close();
    }
  },
);

test("stdio entrypoint proxies tools without constructing a Telegram owner", async () => {
  const owner = new LoopbackMcpServer({
    registry: echoRegistry(),
    testPort: 0,
  });
  const url = await owner.start();
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    cwd: process.cwd(),
    env: {
      ...environment,
      BOT_MCP_HTTP_URL: url.href,
    },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "stdio-proxy-test", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map(({ name }) => name),
      ["echo_safe"],
    );
    const called = await client.callTool({
      name: "echo_safe",
      arguments: { value: "through proxy" },
    });
    assert.deepEqual(called.content, [
      { type: "text", text: "through proxy" },
    ]);
  } finally {
    await client.close();
    await owner.close();
  }
});

test(
  "stdio proxy forwards caller cancellation to the loopback owner",
  { timeout: 15_000 },
  async () => {
    const lifecycle = cancellationLifecycle();
    const owner = new LoopbackMcpServer({
      registry: cancellableRegistry(lifecycle),
      testPort: 0,
    });
    const url = await owner.start();
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined,
      ),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      cwd: process.cwd(),
      env: {
        ...environment,
        BOT_MCP_HTTP_URL: url.href,
      },
      stderr: "pipe",
    });
    const client = new Client(
      { name: "stdio-cancellation-test", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      const request = new AbortController();
      const pending = client.callTool(
        {
          name: "wait_for_cancel",
          arguments: {},
        },
        undefined,
        {
          signal: request.signal,
          timeout: 120_000,
        },
      );
      await lifecycle.started;
      request.abort(
        new DOMException("cancel proxied request", "AbortError"),
      );

      await assert.rejects(pending);
      await lifecycle.cancelled;
      assert.equal(lifecycle.observedSignal?.aborted, true);
    } finally {
      await client.close();
      await owner.close();
    }
  },
);

function echoRegistry(): BotToolRegistry {
  return {
    listTools() {
      return [
        {
          name: "echo_safe",
          description: "Echoes a test value.",
          inputSchema: {
            type: "object",
            properties: {
              value: { type: "string" },
            },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ];
    },
    async callTool(name, rawArgs) {
      assert.equal(name, "echo_safe");
      const value =
        rawArgs &&
        typeof rawArgs === "object" &&
        typeof (rawArgs as Record<string, unknown>).value ===
          "string"
          ? (rawArgs as Record<string, string>).value
          : "";
      return {
        content: [{ type: "text", text: value }],
      };
    },
  };
}

type CancellationLifecycle = {
  started: Promise<void>;
  cancelled: Promise<void>;
  markStarted: () => void;
  markCancelled: () => void;
  observedSignal?: AbortSignal;
};

function cancellationLifecycle(): CancellationLifecycle {
  let markStarted!: () => void;
  let markCancelled!: () => void;
  return {
    started: new Promise<void>((resolve) => {
      markStarted = resolve;
    }),
    cancelled: new Promise<void>((resolve) => {
      markCancelled = resolve;
    }),
    markStarted: () => markStarted(),
    markCancelled: () => markCancelled(),
  };
}

function cancellableRegistry(
  lifecycle: CancellationLifecycle,
): BotToolRegistry {
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
      const signal = options?.signal;
      lifecycle.observedSignal = signal;
      lifecycle.markStarted();
      if (signal && !signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
      lifecycle.markCancelled();
      throw new DOMException(
        "Tool observed MCP cancellation.",
        "AbortError",
      );
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for MCP session lifecycle.");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}
