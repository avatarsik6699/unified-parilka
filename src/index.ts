#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { stringify } from "./json.js";
import {
  LoopbackMcpEndpoint,
  parseLoopbackMcpEndpoint,
} from "./mcp-loopback.js";
import {
  PARILKA_MCP_NAME,
  PARILKA_MCP_VERSION,
  createParilkaMcpServer,
} from "./mcp-protocol.js";
import { createLogger } from "./observability/logger.js";
import { safeError } from "./observability/redaction.js";
import type { MessageStore } from "./store.js";
import type { TelegramGateway } from "./telegram/types.js";

const logger = createLogger({ service: "mcp" });
const LOOPBACK_SESSION_KEEPALIVE_MS = 10 * 60_000;

export async function main(): Promise<void> {
  const endpoint = parseLoopbackMcpEndpoint();
  if (process.argv.includes("--validate-config")) {
    const { loadConfig, redactedConfig } = await import("./config.js");
    const config = loadConfig();
    process.stdout.write(
      `${stringify({
        ok: true,
        config: redactedConfig(config),
        mcp: { mode: "proxy", url: endpoint.url.href },
      })}\n`,
    );
    return;
  }
  if (process.argv.includes("--print-config")) {
    const { loadConfig, redactedConfig } = await import("./config.js");
    const config = loadConfig();
    process.stdout.write(
      `${stringify({
        ...redactedConfig(config),
        mcp: { mode: "proxy", url: endpoint.url.href },
      })}\n`,
    );
    return;
  }

  if (process.argv.includes("--direct")) {
    await runDirect();
    return;
  }
  await runProxy(endpoint);
}

/**
 * Normal production mode. The stdio process owns no Telegram credentials,
 * session database, application store, or MTProto connection. It forwards the
 * two tool protocol methods to the sync daemon on a fixed loopback endpoint.
 */
async function runProxy(
  endpoint: LoopbackMcpEndpoint,
): Promise<void> {
  const remoteTransport = new StreamableHTTPClientTransport(
    endpoint.url,
    {
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
    },
  );
  const remote = new Client(
    {
      name: `${PARILKA_MCP_NAME}-stdio-proxy`,
      version: PARILKA_MCP_VERSION,
    },
    { capabilities: {} },
  );
  await remote.connect(remoteTransport, {
    timeout: 5_000,
  });

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
        })}\n`,
      );
    } finally {
      await closeRemoteClient(remote, remoteTransport);
    }
    return;
  }

  const local = new Server(
    {
      name: PARILKA_MCP_NAME,
      version: PARILKA_MCP_VERSION,
    },
    { capabilities: { tools: {} } },
  );
  local.setRequestHandler(
    ListToolsRequestSchema,
    async (request, extra) =>
      remote.listTools(request.params, {
        timeout: 30_000,
        signal: extra.signal,
      }),
  );
  local.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) =>
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
      void remote
        .ping({ timeout: 5_000 })
        .catch((error) => {
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

/**
 * Explicit recovery mode for a stopped owner daemon. It is intentionally
 * opt-in because running it beside the daemon would create another MTProto
 * session owner.
 */
async function runDirect(): Promise<void> {
  const [
    { loadConfig },
    { MessageStore },
    { assertExclusiveMtprotoOwner },
    { createTelegramGateway },
    { TelegramTools },
  ] = await Promise.all([
    import("./config.js"),
    import("./store.js"),
    import("./telegram/exclusive-owner.js"),
    import("./telegram/gateway-factory.js"),
    import("./tools.js"),
  ]);
  assertExclusiveMtprotoOwner();
  const config = loadConfig();
  const telegram = await createTelegramGateway(config);
  let store: MessageStore;
  try {
    store = new MessageStore(config.storage.dbPath);
  } catch (error) {
    await telegram.destroy();
    throw error;
  }
  const tools = new TelegramTools(config, telegram, store);
  if (process.argv.includes("--status")) {
    try {
      const result = await tools.callTool("get_status", {});
      process.stdout.write(
        `${firstText(result.content) ?? stringify({
          ok: false,
          error: { code: "empty_status", message: "Status tool returned no text content." },
        })}\n`,
      );
    } finally {
      await destroyResources(telegram, store);
    }
    return;
  }

  const server = createParilkaMcpServer(tools);
  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (closeServer: boolean): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        let failure: unknown;
        if (closeServer) {
          try {
            await server.close();
          } catch (error) {
            failure = error;
          }
        }
        try {
          await destroyResources(telegram, store);
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
    logger.info({ event: "mcp.direct.signal", signal });
    void shutdown(true).catch((error) => {
      logger.error({
        event: "mcp.direct.shutdown_failed",
        error: safeError(error),
      });
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  server.onclose = () => {
    void shutdown(false).catch((error) => {
      logger.error({
        event: "mcp.direct.cleanup_failed",
        error: safeError(error),
      });
      process.exitCode = 1;
    });
  };

  try {
    await server.connect(transport);
    logger.warn({
      event: "mcp.direct.started",
      transport: config.telegram.transport,
    });
  } catch (error) {
    await shutdown(false);
    throw error;
  }
}

async function destroyResources(
  telegram: TelegramGateway,
  store: MessageStore,
): Promise<void> {
  let failure: unknown;
  try {
    await telegram.destroy();
  } catch (error) {
    failure = error;
  }
  try {
    store.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    throw failure;
  }
}

function firstText(
  content: unknown,
): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const item of content) {
    if (
      item != null &&
      typeof item === "object" &&
      (item as Record<string, unknown>).type === "text" &&
      typeof (item as Record<string, unknown>).text === "string"
    ) {
      return (item as Record<string, string>).text;
    }
  }
  return undefined;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error) => {
    logger.error({
      event: "mcp.fatal",
      error: safeError(error),
    });
    process.exitCode = 1;
  });
}
