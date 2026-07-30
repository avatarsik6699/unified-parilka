import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { TelegramTools } from "./tools.js";

export const PARILKA_MCP_NAME = "telegram-parilka-mcp";
export const PARILKA_MCP_VERSION = "0.2.0";

export type ParilkaToolRegistry = Pick<
  TelegramTools,
  "listTools" | "callTool"
>;

/**
 * One protocol surface shared by the loopback owner and the explicit
 * recovery/direct entrypoint. Keeping registration here prevents the stdio
 * adapter and HTTP server from drifting into different tool contracts.
 */
export function createParilkaMcpServer(
  registry: ParilkaToolRegistry,
): Server {
  const server = new Server(
    {
      name: PARILKA_MCP_NAME,
      version: PARILKA_MCP_VERSION,
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.listTools(),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    registry.callTool(
      request.params.name,
      request.params.arguments ?? {},
      { signal: extra.signal },
    ),
  );
  return server;
}
