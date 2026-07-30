import { ok, ToolError } from "../errors.js";
import {
  emptySchema,
  type TelegramToolContext,
  type ToolCallOptions,
  type ToolContent,
} from "./contracts.js";
import {
  getThreadContext,
  indexEmbeddings,
  readHistory,
  searchMessages,
  semanticSearchMessages,
} from "./read-handlers.js";
import {
  jsonTool,
  throwIfToolAborted,
  toolFailure,
} from "./response.js";
import {
  previewMessage,
  replyToMessage,
  sendMessage,
} from "./send-handlers.js";
import {
  getChatInfo,
  getStatus,
  resolveChat,
  safeConfig,
  syncHistory,
} from "./sync-health-handlers.js";

/**
 * Explicit dispatch for the fixed 13-tool MCP surface.
 *
 * This is deliberately a switch rather than a generic plugin registry:
 * adding a tool requires an intentional definition and handler branch.
 */
export async function callTelegramTool(
  context: TelegramToolContext,
  name: string,
  rawArgs: unknown,
  options: ToolCallOptions = {},
): Promise<ToolContent> {
  try {
    throwIfToolAborted(options.signal);
    switch (name) {
      case "get_config":
        emptySchema.parse(rawArgs ?? {});
        return jsonTool(ok({ config: safeConfig(context) }));
      case "get_status":
        return jsonTool(getStatus(context, rawArgs));
      case "resolve_chat":
        return jsonTool(
          await resolveChat(context, rawArgs),
        );
      case "get_chat_info":
        return jsonTool(
          await getChatInfo(context, rawArgs),
        );
      case "sync_history":
        return jsonTool(
          await syncHistory(
            context,
            rawArgs,
            options.signal,
          ),
        );
      case "read_history":
        return jsonTool(
          await readHistory(context, rawArgs),
        );
      case "search_messages":
        return jsonTool(
          await searchMessages(
            context,
            rawArgs,
            options.signal,
          ),
        );
      case "semantic_search_messages":
        return jsonTool(
          await semanticSearchMessages(
            context,
            rawArgs,
            options.signal,
          ),
        );
      case "index_embeddings":
        return jsonTool(
          await indexEmbeddings(
            context,
            rawArgs,
            options.signal,
          ),
        );
      case "get_thread_context":
        return jsonTool(
          await getThreadContext(context, rawArgs),
        );
      case "preview_message":
        return jsonTool(
          await previewMessage(context, rawArgs),
        );
      case "send_message":
        return jsonTool(
          await sendMessage(context, rawArgs),
        );
      case "reply_to_message":
        return jsonTool(
          await replyToMessage(context, rawArgs),
        );
      default:
        throw new ToolError({
          category: "internal",
          retryable: false,
          message: `Unknown tool: ${name}`,
        });
    }
  } catch (error) {
    return toolFailure(error);
  }
}
