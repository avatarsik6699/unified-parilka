import {
  assertTimeZone,
  DEFAULT_TIME_ZONE,
} from "./calendar.js";
import {
  executeDayDigest,
  executeSearchChat,
  executeThreadContext,
  type CacheExecutorContext,
} from "./cache-executors.js";
import {
  BOT_READ_TOOL_DEFINITIONS,
  BOT_READ_TOOL_NAMES,
  type BotReadToolCallOptions,
  type BotReadToolDefinition,
  type BotReadToolName,
  type BotReadToolResult,
  type BotReadToolsOptions,
  type WebSearchProvider,
} from "./contracts.js";
import {
  failure,
  normalizeReadToolError,
} from "./payload.js";
import {
  dayDigestArgsSchema,
  searchChatArgsSchema,
  threadContextArgsSchema,
  webSearchArgsSchema,
} from "./schemas.js";
import { executeWebSearch } from "./web-executor.js";

const DEFAULT_CHAT_SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_WEB_TIMEOUT_MS = 60_000;
const MAX_WEB_TIMEOUT_MS = 5 * 60_000;

export class BotReadTools {
  readonly #cacheContext: CacheExecutorContext;
  readonly #webSearch: WebSearchProvider | undefined;
  readonly #webSearchTimeoutMs: number;

  constructor(options: BotReadToolsOptions) {
    const chatId = requireNonEmpty(options.chatId, "chatId");
    const cache = options.cache;
    this.#webSearch = options.webSearch;
    const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
    assertTimeZone(timeZone);
    const chatSearchTimeoutMs = boundedPositiveInteger(
      options.chatSearchTimeoutMs ?? DEFAULT_CHAT_SEARCH_TIMEOUT_MS,
      MAX_WEB_TIMEOUT_MS,
      "chatSearchTimeoutMs",
    );
    this.#webSearchTimeoutMs = boundedPositiveInteger(
      options.webSearchTimeoutMs ?? DEFAULT_WEB_TIMEOUT_MS,
      MAX_WEB_TIMEOUT_MS,
      "webSearchTimeoutMs",
    );
    this.#cacheContext = {
      chatId,
      cache,
      timeZone,
      chatSearchTimeoutMs,
    };
  }

  listTools(): readonly BotReadToolDefinition[] {
    return BOT_READ_TOOL_DEFINITIONS;
  }

  async callTool(
    name: string,
    rawArgs: unknown,
    options: BotReadToolCallOptions = {},
  ): Promise<BotReadToolResult> {
    if (!isBotReadToolName(name)) {
      return failure(name, {
        code: "unknown_tool",
        retryable: false,
        message: `Unknown read tool: ${name}`,
      });
    }

    try {
      switch (name) {
        case "search_chat":
          return await executeSearchChat(
            this.#cacheContext,
            searchChatArgsSchema.parse(rawArgs ?? {}),
            options.signal,
          );
        case "day_digest":
          return executeDayDigest(
            this.#cacheContext,
            dayDigestArgsSchema.parse(rawArgs ?? {}),
          );
        case "thread_context":
          return executeThreadContext(
            this.#cacheContext,
            threadContextArgsSchema.parse(rawArgs ?? {}),
          );
        case "web_search":
          return await executeWebSearch(
            this.#webSearch,
            webSearchArgsSchema.parse(rawArgs ?? {}),
            this.#webSearchTimeoutMs,
            options.signal,
          );
      }
    } catch (error) {
      return failure(name, normalizeReadToolError(error));
    }
  }
}

function isBotReadToolName(value: string): value is BotReadToolName {
  return (BOT_READ_TOOL_NAMES as readonly string[]).includes(value);
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new TypeError(`${name} must not be empty.`);
  }
  return trimmed;
}

function boundedPositiveInteger(
  value: number,
  maximum: number,
  name: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new TypeError(
      `${name} must be an integer from 1 to ${maximum}.`,
    );
  }
  return value;
}
