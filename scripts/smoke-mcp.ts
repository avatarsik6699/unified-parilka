import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../src/config.js";
import { LoopbackMcpServer } from "../src/mcp-loopback.js";
import { MessageStore } from "../src/store.js";
import type {
  ChatInfo,
  TelegramGateway,
} from "../src/telegram/types.js";
import { TelegramTools } from "../src/tools.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(join(tmpdir(), "telegram-parilka-mcp-smoke-"));
const smokeChatId = "-1001234567890";
const stderrChunks: string[] = [];
const useWrapper = process.argv.includes("--wrapper");
const useDirect = process.argv.includes("--direct");
const entrypoint =
  `${useWrapper ? "bin-wrapper" : "source"}:` +
  `${useDirect ? "direct-recovery" : "loopback-proxy"}`;
const smokeConfig = createSmokeConfig(tempDir, smokeChatId);
const ownerStore = useDirect
  ? undefined
  : new MessageStore(smokeConfig.storage.dbPath);
const owner = ownerStore
  ? new LoopbackMcpServer({
      registry: new TelegramTools(
        smokeConfig,
        createSmokeTelegram(smokeChatId),
        ownerStore,
      ),
      testPort: 0,
    })
  : undefined;
const ownerUrl = await owner?.start();

const transport = new StdioClientTransport({
  command: useWrapper ? join(repoRoot, "bin", "telegram-parilka-mcp") : process.execPath,
  args: useWrapper
    ? useDirect
      ? ["--direct"]
      : []
    : [
        "--import",
        "tsx",
        "src/index.ts",
        ...(useDirect ? ["--direct"] : []),
      ],
  cwd: repoRoot,
  stderr: "pipe",
  env: {
    ...getDefaultEnvironment(),
    NODE_NO_WARNINGS: "1",
    TELEGRAM_API_ID: "0",
    TELEGRAM_API_HASH: "",
    TELEGRAM_SESSION: "",
    TELEGRAM_SESSION_STRING_PERSONAL: "",
    TELEGRAM_SESSION_STRING_WIFE: "",
    SESSION: "",
    TELEGRAM_PHONE: "",
    TELEGRAM_DEFAULT_CHAT_ID: smokeChatId,
    TELEGRAM_ALLOWED_CHAT_IDS: smokeChatId,
    TELEGRAM_DB_PATH: join(tempDir, "messages.sqlite"),
    TELEGRAM_REQUIRE_ALLOWLIST: "true",
    TELEGRAM_SEND_ENABLED: "false",
    TELEGRAM_DRY_RUN_DEFAULT: "true",
    TELEGRAM_LIVE_SEND_APPROVAL_BYPASS: "false",
    TELEGRAM_EMBEDDINGS_ENABLED: "false",
    TELEGRAM_EMBEDDINGS_API_KEY: "",
    OPENAI_API_KEY: "",
    ...(useDirect
      ? { PARILKA_MTPROTO_EXCLUSIVE_OWNER: "true" }
      : {}),
    ...(ownerUrl
      ? { PARILKA_MCP_HTTP_URL: ownerUrl.href }
      : {}),
  },
});

transport.stderr?.on("data", (chunk: Buffer | string) => {
  stderrChunks.push(chunk.toString());
});

const client = new Client({ name: "telegram-parilka-mcp-smoke", version: "0.1.0" }, { capabilities: {} });

try {
  await client.connect(transport, { timeout: 5_000 });

  const tools = await client.listTools(undefined, { timeout: 5_000 });
  assert(tools.tools.some((tool) => tool.name === "get_config"), "tools/list did not include get_config");

  const result = await client.callTool({ name: "get_config", arguments: {} }, undefined, { timeout: 5_000 });
  const payload = parseTextPayload(result.content);
  assert(payload.ok === true, "get_config did not return ok:true");
  assert(payload.config?.sendEnabled === false, "smoke config must keep live sends disabled");
  assert(payload.config?.dryRunDefault === true, "smoke config must keep dry-run enabled");
  assert(payload.config?.isTelegramConfigured === false, "smoke must not inherit Telegram credentials");
  assert(payload.config?.embeddings?.enabled === false, "smoke must keep embeddings disabled");
  assert(payload.config?.embeddings?.configured === false, "smoke must not inherit embedding credentials");

  console.log(JSON.stringify({ ok: true, entrypoint, tools: tools.tools.length, checkedTool: "get_config" }, null, 2));
} catch (error) {
  console.error("MCP smoke failed:", error);
  const stderr = stderrChunks.join("").trim();
  if (stderr) {
    console.error("Server stderr:");
    console.error(stderr);
  }
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  await owner?.close().catch(() => undefined);
  ownerStore?.close();
  rmSync(tempDir, { recursive: true, force: true });
}

function createSmokeTelegram(chatId: string): TelegramGateway {
  const chat: ChatInfo = {
    chatId,
    requested: chatId,
    kind: "Smoke",
  };
  return {
    isConfigured: false,
    assertChatAllowed(requested) {
      if (requested !== chatId) {
        throw new Error("Smoke chat is not allowlisted.");
      }
    },
    async resolveChat() {
      return { info: chat };
    },
    async getMessages() {
      return { chat, messages: [] };
    },
    async iterateMessages() {
      return {
        chat,
        messages: (async function* () {})(),
      };
    },
    async sendMessage() {
      throw new Error("Smoke gateway does not send.");
    },
    async disconnect() {},
    async destroy() {},
  };
}

function createSmokeConfig(
  directory: string,
  chatId: string,
): AppConfig {
  return {
    telegram: {
      apiId: 0,
      apiHash: "",
      session: "",
      phone: "",
      defaultChatId: chatId,
      allowedChatIds: [chatId],
      requireAllowlistedChat: true,
      connectionRetries: 1,
      transport: "mtcute",
      mtcute: {
        authStoragePath: join(directory, "mtcute-auth.sqlite"),
        historyPageSize: 100,
        maxHistoryMessages: 1_000_000,
        connectionMaxAttempts: 3,
        connectionTimeoutMs: 30_000,
        connectionRetryInitialMs: 250,
        connectionRetryMaxMs: 4_000,
        requestTimeoutMs: 120_000,
        requestMaxRetries: 2,
        requestRetryDelayMs: 1_000,
        floodWaitMaxMs: 10_000,
      },
    },
    storage: {
      dbPath: join(directory, "messages.sqlite"),
    },
    safety: {
      sendEnabled: false,
      dryRunDefault: true,
      maxSendChars: 4_096,
      liveSendApprovalTtlMs: 300_000,
      liveSendApprovalBypass: false,
    },
    sync: {
      batchSize: 100,
      maxSyncLimit: 500_000,
      floodWaitMaxSleepSec: 10,
      historyWaitTimeSec: 1,
      historyOperationTimeoutMs: 120_000,
      intervalMs: 60_000,
      recentLimit: 300,
      backfillLimit: 1_000,
      transientBackoffInitialMs: 5_000,
      transientBackoffMaxMs: 300_000,
    },
    embeddings: {
      enabled: false,
      backend: "external_openai",
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      localEndpoint: "",
      localRequestTimeoutMs: 30_000,
      rerankTimeoutMs: 10_000,
      rerankMaxCandidates: 0,
      model: "text-embedding-3-small",
      dimensions: 256,
      apiBatchSize: 64,
      requestTimeoutMs: 60_000,
      maxRetries: 2,
      retryInitialMs: 1_000,
      retryMaxMs: 30_000,
      tickIntervalMs: 60_000,
      tickBudgetMs: 30_000,
      chunkMessages: 12,
      chunkOverlapMessages: 0,
      chunkMaxChars: 1_600,
      tickChunkLimit: 100,
      maxChunksPerRun: 1_000,
      maxCharsPerRun: 500_000,
      vectorCandidateLimit: 20_000,
      searchLimit: 12,
    },
    memory: {
      memoryMaxChars: 2_000,
    },
    throttle: {
      userCooldownMs: 20_000,
      maxPendingPerUserPerChat: 1,
      maxQueuePerChat: 25,
      maxAgeMs: 120_000,
      globalConcurrency: 2,
      maxRunningPerChat: 1,
    },
  };
}

function parseTextPayload(content: unknown): Record<string, any> {
  assert(Array.isArray(content), "tool response content was not an array");
  const text = content.find((item): item is { type: "text"; text: string } => {
    return item != null && typeof item === "object" && "type" in item && item.type === "text" && "text" in item;
  })?.text;
  assert(typeof text === "string", "tool response did not contain text content");
  const parsed = JSON.parse(text) as unknown;
  assert(parsed != null && typeof parsed === "object" && !Array.isArray(parsed), "tool response was not a JSON object");
  return parsed as Record<string, any>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
