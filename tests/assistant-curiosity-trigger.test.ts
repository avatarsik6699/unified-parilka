import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateCuriosityGate,
  windowStart,
} from "../src/assistant-curiosity/heuristics.js";
import { runCuriosityTriggerTick } from "../src/assistant-curiosity/tick.js";
import type {
  AssistantCuriosityDecisionRequest,
  AssistantCuriosityDecisionResult,
  AssistantCuriosityPort,
  AssistantCuriositySendPort,
  AssistantCuriositySendResult,
  AssistantCuriosityRuntimeConfig,
  AssistantCuriosityStore,
} from "../src/assistant-curiosity/types.js";
import type {
  StoredAssistantCuriosityTriggerState,
  StoredChatMemory,
  StoredMessage,
} from "../src/store.js";

const BASE_CONFIG: AssistantCuriosityRuntimeConfig = {
  chatId: "c1",
  chatTitle: "Тестовый чат",
  personaPrompt: "Ты дружелюбный и любопытный.",
  botDisplayName: "Бот",
  heuristics: {
    activeHourStartMoscow: 9,
    activeHourEndMoscow: 23,
    minSilenceMs: 20 * 60_000,
    minSilenceSinceOwnQuestionMs: 6 * 60 * 60_000,
    maxInitiationsPerWindow: 3,
    windowMs: 24 * 60 * 60_000,
    pendingAnswerGraceMs: 12 * 60 * 60_000,
    baseAskProbability: 0.05,
    maxAskProbability: 0.5,
  },
};

// Always passes the probability roll (roll < any positive probability).
const ALWAYS_ROLL = () => 0;
// Never passes the probability roll (roll >= any probability <= 1).
const NEVER_ROLL = () => 1;

// 2026-01-15T10:00:00Z is 13:00 Europe/Moscow (UTC+3) -- inside 9-23.
const ACTIVE_NOW = new Date("2026-01-15T10:00:00.000Z");
// 2026-01-15T02:00:00Z is 05:00 Europe/Moscow -- outside 9-23.
const NIGHT_NOW = new Date("2026-01-15T02:00:00.000Z");

test("heuristic gate: outside active hours blocks regardless of other state", () => {
  const result = evaluateCuriosityGate({
    state: undefined,
    config: BASE_CONFIG.heuristics,
    now: NIGHT_NOW,
    lastMessageAtMs: undefined,
    recentMessageCount: 0,
    random: ALWAYS_ROLL,
  });
  assert.equal(result.pass, false);
  assert.equal(result.reason, "outside_active_hours");
});

test("heuristic gate: a fresh chat is very unlikely to pass, but not impossible", () => {
  const blocked = evaluateCuriosityGate({
    state: undefined,
    config: BASE_CONFIG.heuristics,
    now: ACTIVE_NOW,
    lastMessageAtMs: ACTIVE_NOW.getTime() - 60_000,
    recentMessageCount: 0,
    random: NEVER_ROLL,
  });
  assert.equal(blocked.pass, false);
  assert.equal(blocked.reason, "not_this_time");
  assert.ok(blocked.probability !== undefined && blocked.probability > 0);

  const passed = evaluateCuriosityGate({
    state: undefined,
    config: BASE_CONFIG.heuristics,
    now: ACTIVE_NOW,
    lastMessageAtMs: ACTIVE_NOW.getTime() - 60_000,
    recentMessageCount: 0,
    random: ALWAYS_ROLL,
  });
  assert.equal(passed.pass, true);
});

test("heuristic gate: probability climbs with silence and is damped by recent chat activity", () => {
  const quiet = evaluateCuriosityGate({
    state: undefined,
    config: BASE_CONFIG.heuristics,
    now: ACTIVE_NOW,
    lastMessageAtMs: ACTIVE_NOW.getTime() - 60 * 60_000, // well past minSilenceMs
    recentMessageCount: 0,
    random: ALWAYS_ROLL,
  });
  const busy = evaluateCuriosityGate({
    state: undefined,
    config: BASE_CONFIG.heuristics,
    now: ACTIVE_NOW,
    lastMessageAtMs: ACTIVE_NOW.getTime() - 60 * 60_000,
    recentMessageCount: 40, // a lively chat right up to the cutoff
    random: ALWAYS_ROLL,
  });

  assert.ok(quiet.probability !== undefined && busy.probability !== undefined);
  assert.equal(quiet.probability, BASE_CONFIG.heuristics.maxAskProbability);
  assert.ok(busy.probability! < quiet.probability!);
  assert.ok(busy.probability! >= BASE_CONFIG.heuristics.baseAskProbability);
});

test("heuristic gate: asking again too soon after the last question is blocked", () => {
  const state: StoredAssistantCuriosityTriggerState = {
    chatId: "c1",
    lastInitiatedAtMs: ACTIVE_NOW.getTime() - 60_000,
    lastCheckedAtMs: null,
    windowStartMs: null,
    initiatedCountInWindow: 0,
    lastAskedMessageId: null,
    lastAskedAnsweredAtMs: null,
    updatedAtMs: 0,
  };
  const result = evaluateCuriosityGate({
    state,
    config: BASE_CONFIG.heuristics,
    now: ACTIVE_NOW,
    lastMessageAtMs: undefined,
    recentMessageCount: 0,
    random: ALWAYS_ROLL,
  });
  assert.equal(result.pass, false);
  assert.equal(result.reason, "recently_initiated");
});

test("heuristic gate: a still-unanswered recent question blocks a new one", () => {
  const state: StoredAssistantCuriosityTriggerState = {
    chatId: "c1",
    lastInitiatedAtMs: ACTIVE_NOW.getTime() - 60 * 60_000,
    lastCheckedAtMs: null,
    windowStartMs: null,
    initiatedCountInWindow: 1,
    lastAskedMessageId: 42,
    lastAskedAnsweredAtMs: null,
    updatedAtMs: 0,
  };
  const result = evaluateCuriosityGate({
    state,
    config: {
      ...BASE_CONFIG.heuristics,
      minSilenceSinceOwnQuestionMs: 0,
    },
    now: ACTIVE_NOW,
    lastMessageAtMs: undefined,
    recentMessageCount: 0,
    random: ALWAYS_ROLL,
  });
  assert.equal(result.pass, false);
  assert.equal(result.reason, "awaiting_answer");
});

test("heuristic gate: an already-answered question does not block a new one", () => {
  const state: StoredAssistantCuriosityTriggerState = {
    chatId: "c1",
    lastInitiatedAtMs: ACTIVE_NOW.getTime() - 60 * 60_000,
    lastCheckedAtMs: null,
    windowStartMs: null,
    initiatedCountInWindow: 1,
    lastAskedMessageId: 42,
    lastAskedAnsweredAtMs: ACTIVE_NOW.getTime() - 30 * 60_000,
    updatedAtMs: 0,
  };
  const result = evaluateCuriosityGate({
    state,
    config: {
      ...BASE_CONFIG.heuristics,
      minSilenceSinceOwnQuestionMs: 0,
    },
    now: ACTIVE_NOW,
    lastMessageAtMs: ACTIVE_NOW.getTime() - 60 * 60_000,
    recentMessageCount: 0,
    random: ALWAYS_ROLL,
  });
  assert.equal(result.pass, true);
});

test("heuristic gate: rate limit blocks once the window quota is reached", () => {
  const state: StoredAssistantCuriosityTriggerState = {
    chatId: "c1",
    lastInitiatedAtMs: null,
    lastCheckedAtMs: null,
    windowStartMs: windowStart(
      ACTIVE_NOW.getTime(),
      BASE_CONFIG.heuristics.windowMs,
    ),
    initiatedCountInWindow: 3,
    lastAskedMessageId: null,
    lastAskedAnsweredAtMs: null,
    updatedAtMs: 0,
  };
  const result = evaluateCuriosityGate({
    state,
    config: BASE_CONFIG.heuristics,
    now: ACTIVE_NOW,
    lastMessageAtMs: undefined,
    recentMessageCount: 0,
    random: ALWAYS_ROLL,
  });
  assert.equal(result.pass, false);
  assert.equal(result.reason, "rate_limited");
});

class FakeCuriosityStore implements AssistantCuriosityStore {
  history: StoredMessage[] = [];
  state: StoredAssistantCuriosityTriggerState | undefined;
  memory: StoredChatMemory | undefined;
  topics: string[] = [];
  checks: number[] = [];
  initiations: {
    chatId: string;
    windowStartMs: number;
    askedMessageId: number;
    nowMs?: number;
  }[] = [];
  recordedTopics: string[] = [];

  getAssistantCuriosityTriggerState():
    StoredAssistantCuriosityTriggerState | undefined {
    return this.state;
  }

  recordAssistantCuriosityTriggerCheck(
    _chatId: string,
    nowMs = Date.now(),
  ): void {
    this.checks.push(nowMs);
  }

  recordAssistantCuriosityInitiation(params: {
    chatId: string;
    windowStartMs: number;
    askedMessageId: number;
    nowMs?: number;
  }): void {
    this.initiations.push(params);
  }

  recordAssistantCuriosityTopic(_chatId: string, topicSummary: string): void {
    this.recordedTopics.push(topicSummary);
  }

  getRecentAssistantCuriosityTopics(): string[] {
    return this.topics;
  }

  getHistory(): StoredMessage[] {
    return this.history;
  }

  getChatMemory(): StoredChatMemory | undefined {
    return this.memory;
  }
}

function message(messageId: number, text: string, date: string): StoredMessage {
  return { id: messageId, chatId: "c1", messageId, text, date };
}

class FakeDecisionPort implements AssistantCuriosityPort {
  calls = 0;
  result: AssistantCuriosityDecisionResult;
  constructor(result: AssistantCuriosityDecisionResult) {
    this.result = result;
  }
  async decide(
    _request: AssistantCuriosityDecisionRequest,
  ): Promise<AssistantCuriosityDecisionResult> {
    this.calls += 1;
    return this.result;
  }
}

class FakeSendPort implements AssistantCuriositySendPort {
  calls: { chatId: string; text: string }[] = [];
  result: AssistantCuriositySendResult;
  constructor(result: AssistantCuriositySendResult) {
    this.result = result;
  }
  async sendMessage(
    chatId: string,
    text: string,
  ): Promise<AssistantCuriositySendResult> {
    this.calls.push({ chatId, text });
    return this.result;
  }
}

test("tick: an empty chat is reported without touching the port", async () => {
  const store = new FakeCuriosityStore();
  const port = new FakeDecisionPort({
    shouldAsk: false,
    model: "m",
    providerId: "p",
  });
  const send = new FakeSendPort({ messageId: 1 });

  const report = await runCuriosityTriggerTick({
    store,
    config: BASE_CONFIG,
    port,
    send,
    now: () => ACTIVE_NOW,
    random: NEVER_ROLL,
  });

  assert.equal(report.status, "no_history");
  assert.equal(port.calls, 0);
  assert.equal(send.calls.length, 0);
});

test("tick: a gated heuristic check records the check but skips the port", async () => {
  const store = new FakeCuriosityStore();
  store.history = [message(1, "недавно", "2026-01-15T09:59:30.000Z")];
  const port = new FakeDecisionPort({
    shouldAsk: false,
    model: "m",
    providerId: "p",
  });
  const send = new FakeSendPort({ messageId: 1 });

  const report = await runCuriosityTriggerTick({
    store,
    config: BASE_CONFIG,
    port,
    send,
    now: () => ACTIVE_NOW,
    random: NEVER_ROLL,
  });

  assert.equal(report.status, "gated");
  assert.equal(report.reason, "not_this_time");
  assert.equal(port.calls, 0);
  assert.equal(store.checks.length, 1);
});

test("tick: an 'ask' decision sends, records initiation and the topic", async () => {
  const store = new FakeCuriosityStore();
  store.history = [message(1, "тишина уже час", "2026-01-15T09:00:00.000Z")];
  const port = new FakeDecisionPort({
    shouldAsk: true,
    text: "а что вас вдохновляет в этом проекте?",
    topicSummary: "вдохновение в проекте",
    model: "m",
    providerId: "p",
  });
  const send = new FakeSendPort({ messageId: 777 });

  const report = await runCuriosityTriggerTick({
    store,
    config: BASE_CONFIG,
    port,
    send,
    now: () => ACTIVE_NOW,
    random: ALWAYS_ROLL,
  });

  assert.equal(report.status, "asked");
  assert.equal(report.messageId, 777);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0]?.text, "а что вас вдохновляет в этом проекте?");
  assert.equal(store.initiations.length, 1);
  assert.equal(store.initiations[0]?.askedMessageId, 777);
  assert.equal(store.recordedTopics.length, 1);
  assert.equal(store.recordedTopics[0], "вдохновение в проекте");
});

test("tick: a 'don't ask' decision sends nothing and records no initiation", async () => {
  const store = new FakeCuriosityStore();
  store.history = [message(1, "тишина уже час", "2026-01-15T09:00:00.000Z")];
  const port = new FakeDecisionPort({
    shouldAsk: false,
    model: "m",
    providerId: "p",
  });
  const send = new FakeSendPort({ messageId: 1 });

  const report = await runCuriosityTriggerTick({
    store,
    config: BASE_CONFIG,
    port,
    send,
    now: () => ACTIVE_NOW,
    random: ALWAYS_ROLL,
  });

  assert.equal(report.status, "no_message");
  assert.equal(send.calls.length, 0);
  assert.equal(store.initiations.length, 0);
});

test("tick: a send failure is reported as 'failed' without throwing", async () => {
  const store = new FakeCuriosityStore();
  store.history = [message(1, "тишина уже час", "2026-01-15T09:00:00.000Z")];
  const port = new FakeDecisionPort({
    shouldAsk: true,
    text: "вопрос",
    model: "m",
    providerId: "p",
  });
  const send: AssistantCuriositySendPort = {
    sendMessage: async () => {
      throw new Error("telegram unavailable");
    },
  };

  const report = await runCuriosityTriggerTick({
    store,
    config: BASE_CONFIG,
    port,
    send,
    now: () => ACTIVE_NOW,
    random: ALWAYS_ROLL,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.error?.name, "Error");
});
