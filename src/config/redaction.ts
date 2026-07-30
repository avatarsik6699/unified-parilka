import type { AppConfig } from "./types.js";

const SECRET_URL_QUERY_PARAMS = new Set([
  "api_key",
  "key",
  "token",
  "access_token",
  "authorization",
]);

export function redactedConfig(
  config: AppConfig,
): Record<string, unknown> {
  return {
    telegram: {
      apiId: config.telegram.apiId
        ? "<set>"
        : "<missing>",
      apiHash: config.telegram.apiHash
        ? "<set>"
        : "<missing>",
      session: config.telegram.session
        ? "<set>"
        : "<missing>",
      phone: config.telegram.phone
        ? "<set>"
        : "<missing>",
      defaultChatId: config.telegram.defaultChatId,
      allowedChatIds: config.telegram.allowedChatIds,
      requireAllowlistedChat:
        config.telegram.requireAllowlistedChat,
      connectionRetries:
        config.telegram.connectionRetries,
      transport: config.telegram.transport,
      mtcute: config.telegram.mtcute,
    },
    storage: config.storage,
    safety: config.safety,
    sync: config.sync,
    embeddings: {
      enabled: config.embeddings.enabled,
      configured: Boolean(config.embeddings.apiKey),
      baseUrl: redactUrlCredentials(
        config.embeddings.baseUrl,
      ),
      model: config.embeddings.model,
      dimensions: config.embeddings.dimensions,
      apiBatchSize: config.embeddings.apiBatchSize,
      requestTimeoutMs:
        config.embeddings.requestTimeoutMs,
      maxRetries: config.embeddings.maxRetries,
      retryInitialMs:
        config.embeddings.retryInitialMs,
      retryMaxMs: config.embeddings.retryMaxMs,
      tickIntervalMs:
        config.embeddings.tickIntervalMs,
      tickBudgetMs: config.embeddings.tickBudgetMs,
      chunkMessages: config.embeddings.chunkMessages,
      chunkOverlapMessages:
        config.embeddings.chunkOverlapMessages,
      chunkMaxChars:
        config.embeddings.chunkMaxChars,
      tickChunkLimit:
        config.embeddings.tickChunkLimit,
      maxChunksPerRun:
        config.embeddings.maxChunksPerRun,
      maxCharsPerRun:
        config.embeddings.maxCharsPerRun,
      vectorCandidateLimit:
        config.embeddings.vectorCandidateLimit,
      searchLimit: config.embeddings.searchLimit,
    },
    throttle: config.throttle,
  };
}

export function redactUrlCredentials(
  raw: string,
): string {
  try {
    const url = new URL(raw.trim());
    url.username = "";
    url.password = "";
    const query = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      query.append(
        key,
        SECRET_URL_QUERY_PARAMS.has(key.toLowerCase())
          ? "redacted"
          : value,
      );
    }
    url.search = query.toString();
    return url.toString();
  } catch {
    return raw;
  }
}
