export {
  evaluateCuriosityGate,
  windowStart,
  type HeuristicGateResult,
} from "./assistant-curiosity/heuristics.js";
export {
  AiSdkCuriosityDecisionPort,
  type AiSdkCuriosityDecisionPortOptions,
  type AssistantCuriosityModelRouter,
} from "./assistant-curiosity/port.js";
export { buildAssistantCuriosityPrompt } from "./assistant-curiosity/prompt.js";
export {
  lastMessageTimestampMs,
  renderAvoidTopics,
  renderRecentMessages,
} from "./assistant-curiosity/render.js";
export { runCuriosityTriggerTick } from "./assistant-curiosity/tick.js";
export type {
  AssistantCuriosityDecisionRequest,
  AssistantCuriosityDecisionResult,
  AssistantCuriosityHeuristicConfig,
  AssistantCuriosityPort,
  AssistantCuriosityRuntimeConfig,
  AssistantCuriositySendPort,
  AssistantCuriositySendResult,
  AssistantCuriosityStore,
  AssistantCuriosityTickOptions,
  AssistantCuriosityTickReport,
  AssistantCuriosityTickStatus,
} from "./assistant-curiosity/types.js";
