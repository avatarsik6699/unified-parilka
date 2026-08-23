import { randomUUID } from "node:crypto";
import { buildHumanPersonaSystemPrompt } from "../bot/human-persona-prompt.js";
import { evaluateHeuristicGate, windowStart } from "./heuristics.js";
import { lastMessageTimestampMs, renderRecentMessages } from "./render.js";
import type {
  HumanPersonaTriggerTickOptions,
  HumanPersonaTriggerTickReport,
} from "./types.js";

const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_ITEM_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 2_000;
const DEFAULT_RECENT_SOURCE_CHARS = 40_000;

/**
 * One trigger-engine evaluation (plan Фаза 4e/5 Шаг 4): heuristic gate
 * first (pure resource checks, see `heuristics.ts`), then — only if it
 * passes — a single LLM decision call with the persona's system prompt and
 * the recent chat tail. A "send" decision becomes a pending-approval
 * proposal row, never an immediate send (see 4d: sending is `bot-agi-bot`'s
 * approval path or Шаг 6's direct auto-mode send, not this tick).
 */
export async function runHumanPersonaTriggerTick(
  options: HumanPersonaTriggerTickOptions,
): Promise<HumanPersonaTriggerTickReport> {
  const now = (options.now ?? (() => new Date()))();
  const { store, config } = options;
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;

  const recent = store.getHistory({
    chatId: config.chatId,
    limit: historyLimit,
    order: "desc",
  });
  if (recent.length === 0) {
    store.recordHumanPersonaTriggerCheck(
      config.personaId,
      config.chatId,
      now.getTime(),
    );
    return { status: "no_history" };
  }

  const state = store.getHumanPersonaTriggerState(
    config.personaId,
    config.chatId,
  );
  const gate = evaluateHeuristicGate({
    state,
    config: config.heuristics,
    now,
    lastMessageAtMs: lastMessageTimestampMs(recent),
  });
  store.recordHumanPersonaTriggerCheck(
    config.personaId,
    config.chatId,
    now.getTime(),
  );
  if (!gate.pass) {
    return { status: "gated", reason: gate.reason };
  }

  try {
    const styleProfile = store.getHumanPersonaStyleProfile(
      config.personaId,
      config.targetUserKey,
    );
    const systemPrompt = buildHumanPersonaSystemPrompt({
      personaId: config.personaId,
      chatTitle: config.chatTitle,
      styleProfileText: styleProfile?.profileText,
      styleExampleMessages: styleProfile?.exampleMessages,
      now,
    });
    const recentMessagesText = renderRecentMessages(
      recent,
      DEFAULT_RECENT_SOURCE_CHARS,
    );
    const signal = AbortSignal.timeout(
      options.itemTimeoutMs ?? DEFAULT_ITEM_TIMEOUT_MS,
    );
    const decision = await options.port.decide({
      personaId: config.personaId,
      chatId: config.chatId,
      systemPrompt,
      recentMessagesText,
      maxOutputChars: options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      signal,
    });

    if (!decision.shouldSend || !decision.text) {
      return { status: "no_message" };
    }

    const proposalId = `human_${randomUUID()}`;
    store.createHumanPersonaProposal({
      id: proposalId,
      personaId: config.personaId,
      chatId: config.chatId,
      proposedText: decision.text,
      autonomyMode: config.autonomyMode,
      nowMs: now.getTime(),
    });
    store.recordHumanPersonaInitiation(
      config.personaId,
      config.chatId,
      windowStart(now.getTime(), config.heuristics.windowMs),
      now.getTime(),
    );
    return { status: "proposed", proposalId };
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
          : "human_persona_trigger_failed",
    };
  }
  return { name: "NonError", code: "human_persona_trigger_failed" };
}
