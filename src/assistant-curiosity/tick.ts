import {
  evaluateCuriosityGate,
  VELOCITY_WINDOW_MS,
  windowStart,
} from "./heuristics.js";
import { buildAssistantCuriosityPrompt } from "./prompt.js";
import {
  countRecentMessages,
  lastMessageTimestampMs,
  renderAvoidTopics,
  renderRecentMessages,
} from "./render.js";
import type {
  AssistantCuriosityTickOptions,
  AssistantCuriosityTickReport,
} from "./types.js";

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_ITEM_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 2_000;
const DEFAULT_RECENT_SOURCE_CHARS = 40_000;

/**
 * One curiosity-trigger evaluation for one chat: heuristic gate first (pure
 * resource checks, see `heuristics.ts`), then -- only if it passes -- a
 * single LLM decision call. Unlike `human-persona-trigger`'s two-phase
 * proposal/approval queue, a "yes" here sends immediately in the same tick:
 * the assistant persona is openly a bot, so there is no approval gate to
 * route through (see AGENTS.md's assistant curiosity trigger note).
 */
export async function runCuriosityTriggerTick(
  options: AssistantCuriosityTickOptions,
): Promise<AssistantCuriosityTickReport> {
  const now = (options.now ?? (() => new Date()))();
  const { store, config } = options;
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;

  const recent = store.getHistory({
    chatId: config.chatId,
    limit: historyLimit,
    order: "desc",
  });
  if (recent.length === 0) {
    store.recordAssistantCuriosityTriggerCheck(config.chatId, now.getTime());
    return { status: "no_history" };
  }

  const state = store.getAssistantCuriosityTriggerState(config.chatId);
  const gate = evaluateCuriosityGate({
    state,
    config: config.heuristics,
    now,
    lastMessageAtMs: lastMessageTimestampMs(recent),
    recentMessageCount: countRecentMessages(
      recent,
      VELOCITY_WINDOW_MS,
      now.getTime(),
    ),
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  store.recordAssistantCuriosityTriggerCheck(config.chatId, now.getTime());
  if (!gate.pass) {
    return {
      status: "gated",
      reason: gate.reason,
      ...(gate.probability === undefined
        ? {}
        : { probability: gate.probability }),
    };
  }

  try {
    const memory = store.getChatMemory(config.chatId);
    const avoidTopics = store.getRecentAssistantCuriosityTopics(config.chatId);
    const systemPrompt = buildAssistantCuriosityPrompt({
      botDisplayName: config.botDisplayName,
      chatTitle: config.chatTitle,
      personaPrompt: config.personaPrompt,
      ...(memory?.memoryText ? { chatMemoryText: memory.memoryText } : {}),
      avoidTopicsText: renderAvoidTopics(avoidTopics),
    });
    const recentMessagesText = renderRecentMessages(
      recent,
      DEFAULT_RECENT_SOURCE_CHARS,
    );
    const signal = AbortSignal.timeout(
      options.itemTimeoutMs ?? DEFAULT_ITEM_TIMEOUT_MS,
    );
    const decision = await options.port.decide({
      chatId: config.chatId,
      systemPrompt,
      recentMessagesText,
      avoidTopicsText: renderAvoidTopics(avoidTopics),
      maxOutputChars: options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      signal,
    });

    if (!decision.shouldAsk || !decision.text) {
      return { status: "no_message" };
    }

    const sent = await options.send.sendMessage(
      config.chatId,
      decision.text,
      signal,
    );
    const nowMs = now.getTime();
    store.recordAssistantCuriosityInitiation({
      chatId: config.chatId,
      windowStartMs: windowStart(nowMs, config.heuristics.windowMs),
      askedMessageId: sent.messageId,
      nowMs,
    });
    store.recordAssistantCuriosityTopic(
      config.chatId,
      decision.topicSummary ?? decision.text.slice(0, 80),
      nowMs,
    );
    return {
      status: "asked",
      messageId: sent.messageId,
      ...(gate.probability === undefined
        ? {}
        : { probability: gate.probability }),
    };
  } catch (error) {
    return { status: "failed", error: safeErrorIdentity(error) };
  }
}

function safeErrorIdentity(error: unknown): { name: string; code: string } {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { name?: unknown; code?: unknown };
    return {
      name:
        typeof candidate.name === "string"
          ? candidate.name.slice(0, 80)
          : "Error",
      code:
        typeof candidate.code === "string" || typeof candidate.code === "number"
          ? String(candidate.code).slice(0, 80)
          : "assistant_curiosity_trigger_failed",
    };
  }
  return { name: "NonError", code: "assistant_curiosity_trigger_failed" };
}
