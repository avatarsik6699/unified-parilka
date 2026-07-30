import type {
  BotRuntimeConfig,
  SafeBotRuntimeConfig,
} from "./contracts.js";

export function safeBotRuntimeConfig(
  config: Readonly<BotRuntimeConfig>,
): SafeBotRuntimeConfig {
  const {
    token: _token,
    webSearch,
    ...safe
  } = config;
  return {
    ...safe,
    tokenConfigured: true,
    ...(webSearch === undefined
      ? {}
      : webSearch.kind === "http"
        ? {
            webSearch: {
              kind: "http",
              endpoint: webSearch.endpoint,
              bearerTokenConfigured:
                webSearch.bearerToken !== undefined,
            },
          }
        : {
            webSearch: {
              kind: "vertex",
              project: webSearch.project,
              model: webSearch.model,
              region: webSearch.region,
              maxOutputTokens: webSearch.maxOutputTokens,
              gcloudPathConfigured:
                webSearch.gcloudPath !== undefined,
            },
          }),
  };
}
