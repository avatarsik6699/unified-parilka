import assert from "node:assert/strict";
import { test } from "node:test";
import { loadHumanPersonaTriggerConfigFromEnv } from "../src/human-persona-trigger/config.js";
import {
  evaluateHeuristicGate,
  windowStart,
} from "../src/human-persona-trigger/heuristics.js";
import { runHumanPersonaTriggerTick } from "../src/human-persona-trigger/tick.js";
import type {
  HumanPersonaTriggerDecisionRequest,
  HumanPersonaTriggerDecisionResult,
  HumanPersonaTriggerPort,
  HumanPersonaTriggerRuntimeConfig,
  HumanPersonaTriggerStore,
} from "../src/human-persona-trigger/types.js";
import type {
  HumanPersonaAutonomyMode,
  StoredChatMemory,
  StoredHumanPersonaProposal,
  StoredHumanPersonaStyleProfile,
  StoredHumanPersonaTriggerState,
  StoredMessage,
} from "../src/store.js";

const BASE_CONFIG: HumanPersonaTriggerRuntimeConfig = {
  personaId: "p1",
  chatId: "c1",
  chatTitle: "Тестовый чат",
  targetUserKey: "u1",
  autonomyMode: "approval",
  heuristics: {
    activeHourStartMoscow: 9,
    activeHourEndMoscow: 23,
    minSilenceMs: 20 * 60_000,
    maxInitiationsPerWindow: 3,
    windowMs: 24 * 60 * 60_000,
  },
};

// 2026-01-15T10:00:00Z is 13:00 Europe/Moscow (UTC+3) -- inside 9-23.
const ACTIVE_NOW = new Date("2026-01-15T10:00:00.000Z");
// 2026-01-15T02:00:00Z is 05:00 Europe/Moscow -- outside 9-23.
const NIGHT_NOW = new Date("2026-01-15T02:00:00.000Z");

test("heuristic gate: outside active hours blocks regardless of other state", () => {
  const result = evaluateHeuristicGate({
    state: undefined,
    config: BASE_CONFIG.heuristics,
    now: NIGHT_NOW,
    lastMessageAtMs: undefined,
  });
  assert.equal(result.pass, false);
  assert.equal(result.reason, "outside_active_hours");
});

test("heuristic gate: a chat with no recent silence is gated as too quiet", () => {
  const result = evaluateHeuristicGate({
    state: undefined,
    config: BASE_CONFIG.heuristics,
    now: ACTIVE_NOW,
    lastMessageAtMs: ACTIVE_NOW.getTime() - 60_000, // 1 minute ago, below 20-minute threshold
  });
  assert.equal(result.pass, false);
  assert.equal(result.reason, "chat_too_quiet");
});

test("heuristic gate: initiating again too soon after the last initiation is blocked", () => {
  const state: StoredHumanPersonaTriggerState = {
    personaId: "p1",
    chatId: "c1",
    lastInitiatedAtMs: ACTIVE_NOW.getTime() - 60_000,
    lastCheckedAtMs: null,
    windowStartMs: null,
    initiatedCountInWindow: 0,
    updatedAtMs: 0,
  };
  const result = evaluateHeuristicGate({
    state,
    config: BASE_CONFIG.heuristics,
    now: ACTIVE_NOW,
    lastMessageAtMs: undefined,
  });
  assert.equal(result.pass, false);
  assert.equal(result.reason, "recently_initiated");
});

test("heuristic gate: rate limit blocks once the window quota is reached", () => {
  const state: StoredHumanPersonaTriggerState = {
    personaId: "p1",
    chatId: "c1",
    lastInitiatedAtMs: null,
    lastCheckedAtMs: null,
    windowStartMs: windowStart(
      ACTIVE_NOW.getTime(),
      BASE_CONFIG.heuristics.windowMs,
    ),
    initiatedCountInWindow: 3,
    updatedAtMs: 0,
  };
  const result = evaluateHeuristicGate({
    state,
    config: BASE_CONFIG.heuristics,
    now: ACTIVE_NOW,
    lastMessageAtMs: undefined,
  });
  assert.equal(result.pass, false);
  assert.equal(result.reason, "rate_limited");
});

test("heuristic gate: passes with no state and old-enough chat silence, inside active hours", () => {
  const result = evaluateHeuristicGate({
    state: undefined,
    config: BASE_CONFIG.heuristics,
    now: ACTIVE_NOW,
    lastMessageAtMs: ACTIVE_NOW.getTime() - 60 * 60_000,
  });
  assert.deepEqual(result, { pass: true });
});

test("env config: undefined unless persona, chat, and target are all set", () => {
  assert.equal(loadHumanPersonaTriggerConfigFromEnv({}), undefined);
  assert.equal(
    loadHumanPersonaTriggerConfigFromEnv({ BOT_HUMAN_PERSONA_ID: "p1" }),
    undefined,
  );
  assert.notEqual(
    loadHumanPersonaTriggerConfigFromEnv({
      BOT_HUMAN_PERSONA_ID: "p1",
      BOT_HUMAN_PERSONA_CHAT_ID: "c1",
      BOT_HUMAN_PERSONA_TARGET_USER: "u1",
    }),
    undefined,
  );
});

test("env config: autonomy mode defaults to approval and requires an exact 'auto'", () => {
  const env = {
    BOT_HUMAN_PERSONA_ID: "p1",
    BOT_HUMAN_PERSONA_CHAT_ID: "c1",
    BOT_HUMAN_PERSONA_TARGET_USER: "u1",
  };
  assert.equal(
    loadHumanPersonaTriggerConfigFromEnv(env)?.autonomyMode,
    "approval",
  );
  assert.equal(
    loadHumanPersonaTriggerConfigFromEnv({
      ...env,
      BOT_HUMAN_PERSONA_AUTONOMY_MODE: "AUTO",
    })?.autonomyMode,
    "approval",
  );
  assert.equal(
    loadHumanPersonaTriggerConfigFromEnv({
      ...env,
      BOT_HUMAN_PERSONA_AUTONOMY_MODE: "auto",
    })?.autonomyMode,
    "auto",
  );
});

test("env config: numeric overrides are parsed and out-of-range values throw", () => {
  const env = {
    BOT_HUMAN_PERSONA_ID: "p1",
    BOT_HUMAN_PERSONA_CHAT_ID: "c1",
    BOT_HUMAN_PERSONA_TARGET_USER: "u1",
    BOT_HUMAN_PERSONA_MAX_INITIATIONS_PER_WINDOW: "7",
  };
  assert.equal(
    loadHumanPersonaTriggerConfigFromEnv(env)?.heuristics
      .maxInitiationsPerWindow,
    7,
  );
  assert.throws(() =>
    loadHumanPersonaTriggerConfigFromEnv({
      ...env,
      BOT_HUMAN_PERSONA_ACTIVE_HOUR_START: "99",
    }),
  );
});

class FakeTriggerStore implements HumanPersonaTriggerStore {
  history: StoredMessage[] = [];
  state: StoredHumanPersonaTriggerState | undefined;
  styleProfile: StoredHumanPersonaStyleProfile | undefined;
  memory: StoredChatMemory | undefined;
  checks: number[] = [];
  initiations: { windowStartMs: number; nowMs: number }[] = [];
  proposals: StoredHumanPersonaProposal[] = [];

  getHumanPersonaTriggerState(): StoredHumanPersonaTriggerState | undefined {
    return this.state;
  }

  recordHumanPersonaTriggerCheck(
    _p: string,
    _c: string,
    nowMs = Date.now(),
  ): void {
    this.checks.push(nowMs);
  }

  recordHumanPersonaInitiation(
    _p: string,
    _c: string,
    windowStartMs: number,
    nowMs = Date.now(),
  ): void {
    this.initiations.push({ windowStartMs, nowMs });
  }

  createHumanPersonaProposal(params: {
    id: string;
    personaId: string;
    chatId: string;
    proposedText: string;
    autonomyMode: HumanPersonaAutonomyMode;
    nowMs?: number;
  }): StoredHumanPersonaProposal {
    const proposal: StoredHumanPersonaProposal = {
      id: params.id,
      personaId: params.personaId,
      chatId: params.chatId,
      proposedText: params.proposedText,
      finalText: null,
      status: "pending",
      autonomyMode: params.autonomyMode,
      approvalChatId: null,
      approvalMessageId: null,
      claimedBy: null,
      claimedAtMs: null,
      decidedAtMs: null,
      error: null,
      createdAtMs: params.nowMs ?? Date.now(),
      updatedAtMs: params.nowMs ?? Date.now(),
    };
    this.proposals.push(proposal);
    return proposal;
  }

  getHumanPersonaStyleProfile(): StoredHumanPersonaStyleProfile | undefined {
    return this.styleProfile;
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

class FakeDecisionPort implements HumanPersonaTriggerPort {
  calls = 0;
  result: HumanPersonaTriggerDecisionResult;
  constructor(result: HumanPersonaTriggerDecisionResult) {
    this.result = result;
  }
  async decide(
    _request: HumanPersonaTriggerDecisionRequest,
  ): Promise<HumanPersonaTriggerDecisionResult> {
    this.calls += 1;
    return this.result;
  }
}

test("tick: an empty chat is reported without touching the port", async () => {
  const store = new FakeTriggerStore();
  const port = new FakeDecisionPort({
    shouldSend: false,
    model: "m",
    providerId: "p",
  });

  const report = await runHumanPersonaTriggerTick({
    store,
    config: BASE_CONFIG,
    port,
    now: () => ACTIVE_NOW,
  });

  assert.equal(report.status, "no_history");
  assert.equal(port.calls, 0);
});

test("tick: a gated heuristic check records the check but skips the port", async () => {
  const store = new FakeTriggerStore();
  store.history = [message(1, "недавно", "2026-01-15T09:59:30.000Z")];
  const port = new FakeDecisionPort({
    shouldSend: false,
    model: "m",
    providerId: "p",
  });

  const report = await runHumanPersonaTriggerTick({
    store,
    config: BASE_CONFIG,
    port,
    now: () => ACTIVE_NOW,
  });

  assert.equal(report.status, "gated");
  assert.equal(report.reason, "chat_too_quiet");
  assert.equal(port.calls, 0);
  assert.equal(store.checks.length, 1);
});

test("tick: a 'send' decision creates a pending proposal and records initiation", async () => {
  const store = new FakeTriggerStore();
  store.history = [message(1, "тишина уже час", "2026-01-15T09:00:00.000Z")];
  const port = new FakeDecisionPort({
    shouldSend: true,
    text: "го покерасим",
    model: "m",
    providerId: "p",
  });

  const report = await runHumanPersonaTriggerTick({
    store,
    config: BASE_CONFIG,
    port,
    now: () => ACTIVE_NOW,
  });

  assert.equal(report.status, "proposed");
  assert.equal(store.proposals.length, 1);
  assert.equal(store.proposals[0]?.proposedText, "го покерасим");
  assert.equal(store.proposals[0]?.status, "pending");
  assert.equal(store.proposals[0]?.autonomyMode, "approval");
  assert.equal(store.initiations.length, 1);
});

test("tick: a 'don't send' decision leaves no proposal and no initiation", async () => {
  const store = new FakeTriggerStore();
  store.history = [message(1, "тишина уже час", "2026-01-15T09:00:00.000Z")];
  const port = new FakeDecisionPort({
    shouldSend: false,
    model: "m",
    providerId: "p",
  });

  const report = await runHumanPersonaTriggerTick({
    store,
    config: BASE_CONFIG,
    port,
    now: () => ACTIVE_NOW,
  });

  assert.equal(report.status, "no_message");
  assert.equal(store.proposals.length, 0);
  assert.equal(store.initiations.length, 0);
});

test("tick: a port failure is reported as 'failed' without throwing", async () => {
  const store = new FakeTriggerStore();
  store.history = [message(1, "тишина уже час", "2026-01-15T09:00:00.000Z")];
  const port: HumanPersonaTriggerPort = {
    decide: async () => {
      throw new Error("model unavailable");
    },
  };

  const report = await runHumanPersonaTriggerTick({
    store,
    config: BASE_CONFIG,
    port,
    now: () => ACTIVE_NOW,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.error?.name, "Error");
});
