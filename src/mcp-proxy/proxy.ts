import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  Server,
  type Server as McpServer,
} from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { LoopbackMcpEndpoint } from "../mcp-loopback.js";
import { BOT_MCP_NAME, BOT_MCP_VERSION } from "../mcp-protocol.js";
import type { JsonEventLogger } from "../observability/contracts.js";
import { safeError } from "../observability/redaction.js";
import { stringify } from "../json.js";
import { firstText } from "./first-text.js";

const LOOPBACK_SESSION_KEEPALIVE_MS = 10 * 60_000;

export async function runProxy(
  endpoint: LoopbackMcpEndpoint,
  logger: JsonEventLogger,
): Promise<void> {
  const remoteTransport = new StreamableHTTPClientTransport(endpoint.url, {
    requestInit: {
      headers: {
        origin: endpoint.url.origin,
      },
    },
    reconnectionOptions: {
      initialReconnectionDelay: 250,
      maxReconnectionDelay: 2_000,
      reconnectionDelayGrowFactor: 2,
      maxRetries: 2,
    },
  });
  const remote = new Client(
    {
      name: `${BOT_MCP_NAME}-stdio-proxy`,
      version: BOT_MCP_VERSION,
    },
    { capabilities: {} },
  );
  await remote.connect(remoteTransport, { timeout: 5_000 });

  if (process.argv.includes("--status")) {
    try {
      const result = await remote.callTool(
        { name: "get_status", arguments: {} },
        undefined,
        { timeout: 30_000 },
      );
      process.stdout.write(
        `${firstText(result.content) ?? stringify({
          ok: false,
          error: { code: "empty_status", message: "Status tool returned no text content." },
        })}
`,
      );
    } finally {
      await closeRemoteClient(remote, remoteTransport);
    }
    return;
  }

  const local: McpServer = new Server(
    {
      name: BOT_MCP_NAME,
      version: BOT_MCP_VERSION,
    },
    { capabilities: { tools: {} } },
  );
  local.setRequestHandler(ListToolsRequestSchema, async (request, extra) =>
    remote.listTools(request.params, {
      timeout: 30_000,
      signal: extra.signal,
    }),
  );
  local.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    remote.callTool(
      {
        name: request.params.name,
        arguments: request.params.arguments ?? {},
      },
      undefined,
      {
        timeout: 5 * 60_000,
        signal: extra.signal,
      },
    ),
  );

  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | undefined;
  let keepaliveTimer: NodeJS.Timeout | undefined;
  const shutdown = (closeLocal: boolean): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = undefined;
        }
        let failure: unknown;
        if (closeLocal) {
          try {
            await local.close();
          } catch (error) {
            failure = error;
          }
        }
        try {
          await closeRemoteClient(remote, remoteTransport);
        } catch (error) {
          failure ??= error;
        }
        if (failure !== undefined) {
          throw failure;
        }
      })();
    }
    return shutdownPromise;
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    logger.info({ event: "mcp.proxy.signal", signal });
    void shutdown(true).catch((error) => {
      logger.error({
        event: "mcp.proxy.shutdown_failed",
        error: safeError(error),
      });
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  local.onclose = () => {
    void shutdown(false).catch((error) => {
      logger.error({
        event: "mcp.proxy.cleanup_failed",
        error: safeError(error),
      });
      process.exitCode = 1;
    });
  };

  try {
    await local.connect(transport);
    keepaliveTimer = setInterval(() => {
      void remote.ping({ timeout: 5_000 }).catch((error) => {
        logger.error({
          event: "mcp.proxy.keepalive_failed",
          error: safeError(error),
          action: "closing_stale_proxy",
        });
        process.exitCode = 1;
        void shutdown(true).catch((shutdownError) => {
          logger.error({
            event: "mcp.proxy.shutdown_failed",
            error: safeError(shutdownError),
          });
        });
      });
    }, LOOPBACK_SESSION_KEEPALIVE_MS);
    keepaliveTimer.unref();
    logger.info({
      event: "mcp.proxy.started",
      endpoint: endpoint.url.href,
    });
  } catch (error) {
    await shutdown(false);
    throw error;
  }
}

async function closeRemoteClient(
  remote: Client,
  transport: StreamableHTTPClientTransport,
): Promise<void> {
  let failure: unknown;
  try {
    await transport.terminateSession();
  } catch (error) {
    failure = error;
  }
  try {
    await remote.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    throw failure;
  }
}
