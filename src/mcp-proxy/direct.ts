import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { MessageStore } from "../store.js";
import type { TelegramGateway } from "../telegram/types.js";
import { createParilkaMcpServer } from "../mcp-protocol.js";
import { TelegramTools } from "../tools.js";
import type { JsonEventLogger } from "../observability/contracts.js";
import { safeError } from "../observability/redaction.js";
import { stringify } from "../json.js";
import { firstText } from "./first-text.js";

export async function runDirect(logger: JsonEventLogger): Promise<void> {
  const [
    { loadConfig },
    { MessageStore },
    { assertExclusiveMtprotoOwner },
    { createTelegramGateway },
    { TelegramTools },
  ] = await Promise.all([
    import("../config.js"),
    import("../store.js"),
    import("../telegram/exclusive-owner.js"),
    import("../telegram/gateway-factory.js"),
    import("../tools.js"),
  ]);
  assertExclusiveMtprotoOwner();
  const config = loadConfig();
  const telegram = await createTelegramGateway(config);
  let store: MessageStore;
  try {
    store = new MessageStore(config.storage.dbPath);
    store.reconcileActiveSendsOnStartup();
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
        })}
`,
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
