import type { BotRuntimeConfig, SafeBotRuntimeConfig } from "./contracts.js";

export function safeBotRuntimeConfig(
  config: Readonly<BotRuntimeConfig>,
): SafeBotRuntimeConfig {
  const {
    token: _token,
    webSearch,
    researchGateway,
    audioTranscribe,
    memoryWriteAuthorizerIds,
    imageGeneration,
    voiceReply,
    newsBriefTrigger,
    vk,
    ...safe
  } = config;
  return {
    ...safe,
    tokenConfigured: true,
    memoryWriteAuthorizerCount: memoryWriteAuthorizerIds.length,
    newsBriefTriggerConfigured: newsBriefTrigger !== undefined,
    audioTranscribe: {
      endpoint: audioTranscribe.endpoint,
      timeoutMs: audioTranscribe.timeoutMs,
      bearerTokenConfigured: audioTranscribe.bearerToken !== undefined,
    },
    ...(webSearch === undefined
      ? {}
      : webSearch.kind === "http"
        ? {
            webSearch: {
              kind: "http",
              endpoint: webSearch.endpoint,
              bearerTokenConfigured: webSearch.bearerToken !== undefined,
            },
          }
        : {
            webSearch: {
              kind: "vertex",
              project: webSearch.project,
              model: webSearch.model,
              region: webSearch.region,
              maxOutputTokens: webSearch.maxOutputTokens,
              gcloudPathConfigured: webSearch.gcloudPath !== undefined,
            },
          }),
    ...(researchGateway === undefined
      ? {}
      : {
          researchGateway: {
            configured: true,
            timeoutMs: researchGateway.timeoutMs,
          },
        }),
    ...(imageGeneration === undefined
      ? {}
      : {
          imageGeneration: {
            provider: imageGeneration.provider,
            apiKeyConfigured: true,
            endpoint: imageGeneration.endpoint,
            timeoutMs: imageGeneration.timeoutMs,
            nsfwAllowed: imageGeneration.nsfwAllowed,
            maxImagesPerTurn: imageGeneration.maxImagesPerTurn,
            maxImagesPerChatPerDay: imageGeneration.maxImagesPerChatPerDay,
          },
        }),
    ...(voiceReply === undefined
      ? {}
      : {
          voiceReply: {
            provider: voiceReply.provider,
            apiKeyConfigured: true,
            endpoint: voiceReply.endpoint,
            timeoutMs: voiceReply.timeoutMs,
            maxRepliesPerTurn: voiceReply.maxRepliesPerTurn,
            maxRepliesPerChatPerDay: voiceReply.maxRepliesPerChatPerDay,
          },
        }),
    ...(vk === undefined
      ? {}
      : {
          vk: {
            groupTokenConfigured: true,
            groupId: vk.groupId,
            apiVersion: vk.apiVersion,
            userTokenConfigured: vk.userToken !== undefined,
            historyBackfillLimit: vk.historyBackfillLimit,
          },
        }),
  };
}
