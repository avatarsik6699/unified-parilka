import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROGRESS_LABELS,
  renderProgressText,
  ToolProgressPublisher,
  type ToolProgressBotApiPort,
  type ToolProgressStore,
} from "../src/bot/tool-progress.js";

type PortCall =
  | { kind: "send"; chatId: string; text: string; signal: AbortSignal }
  | {
      kind: "edit";
      chatId: string;
      messageId: number;
      text: string;
      signal: AbortSignal;
    }
  | { kind: "delete"; chatId: string; messageId: number; signal: AbortSignal };

function fakePort(
  overrides: Partial<ToolProgressBotApiPort> = {},
): ToolProgressBotApiPort & { calls: PortCall[] } {
  const calls: PortCall[] = [];
  return {
    async sendMessage(chatId, text, signal) {
      calls.push({ kind: "send", chatId, text, signal });
      return (
        overrides.sendMessage?.(chatId, text, signal) ?? {
          ok: true,
          messageId: 1,
        }
      );
    },
    async editMessageText(chatId, messageId, text, signal) {
      calls.push({ kind: "edit", chatId, messageId, text, signal });
      return (
        overrides.editMessageText?.(chatId, messageId, text, signal) ?? {
          ok: true,
        }
      );
    },
    async deleteMessage(chatId, messageId, signal) {
      calls.push({ kind: "delete", chatId, messageId, signal });
      return (
        overrides.deleteMessage?.(chatId, messageId, signal) ?? { ok: true }
      );
    },
    calls,
  };
}

function fakeStore(): ToolProgressStore & {
  states: Array<{
    turnId: number;
    workerId: string;
    progress: { messageId?: number; state?: string };
    nowMs?: number;
  }>;
} {
  const states: Array<{
    turnId: number;
    workerId: string;
    progress: { messageId?: number; state?: string };
    nowMs?: number;
  }> = [];
  return {
    saveBotTurnProgress(turnId, workerId, progress, nowMs) {
      states.push({ turnId, workerId, progress, nowMs });
      return true;
    },
    clearBotTurnProgress(turnId, nowMs) {
      states.push({ turnId, workerId: "", progress: {}, nowMs });
      return true;
    },
    states,
  };
}

function makePublisher(options: {
  port?: ToolProgressBotApiPort;
  store?: ToolProgressStore;
  initialMessageId?: number;
  signal?: AbortSignal;
}) {
  const controller = new AbortController();
  return {
    controller,
    publisher: new ToolProgressPublisher({
      turnId: 7,
      workerId: "w1",
      chatId: "-1004242",
      signal: options.signal ?? controller.signal,
      botApi: options.port ?? fakePort(),
      store: options.store ?? fakeStore(),
      initialMessageId: options.initialMessageId,
      now: () => 1_000,
    }),
  };
}

async function drain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Matches one rendered progress line: an icon, a space, and a known fun label. */
const LABEL_ALTERNATION = PROGRESS_LABELS.map((label) =>
  label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
).join("|");
function lineRegExp(icon: string): RegExp {
  return new RegExp(`^${icon} (?:${LABEL_ALTERNATION})$`, "u");
}

test("sends a progress message on the first tool start", async () => {
  const port = fakePort();
  const store = fakeStore();
  const { publisher } = makePublisher({ port, store });

  publisher.onToolStarted({ toolName: "rag_bm25_search", callId: "c1" });
  await drain();
  await publisher.finish(new AbortController().signal);

  assert.equal(port.calls.length, 2);
  assert.equal(port.calls[0].kind, "send");
  assert.equal(port.calls[0].chatId, "-1004242");
  assert.match(port.calls[0].text, lineRegExp("⏳"));
  assert.doesNotMatch(port.calls[0].text, /rag_bm25_search/u);
  assert.ok(port.calls[0].signal instanceof AbortSignal);
  assert.equal(port.calls[1].kind, "delete");
  assert.equal(store.states.length, 3);
  assert.equal(store.states[0]?.progress.state, "dispatching");
  assert.equal(store.states[1]?.progress.state, "active");
});

test("edits the existing message as tools complete, keeping the same label", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({ toolName: "rag_bm25_search", callId: "c1" });
  await drain();
  publisher.onToolCompleted(
    { toolName: "rag_bm25_search", callId: "c1" },
    true,
  );
  await drain();
  await publisher.finish(new AbortController().signal);

  const texts = port.calls
    .filter((call) => call.kind === "send" || call.kind === "edit")
    .map((call) => call.text);
  assert.equal(texts.length, 2);
  assert.match(texts[0] ?? "", lineRegExp("⏳"));
  assert.match(texts[1] ?? "", lineRegExp("✓"));
  // The label picked at start must survive into the completed line.
  assert.equal(texts[0]?.slice(2), texts[1]?.slice(2));
});

test("shows thinking as a separate safe status before a tool call, both unlabeled by real name", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onThinkingStarted({ callId: "thinking-1" });
  await drain();
  publisher.onThinkingCompleted({ callId: "thinking-1" }, true);
  publisher.onToolStarted({ toolName: "web_search", callId: "search-1" });
  await drain();
  await publisher.finish(new AbortController().signal);

  const texts = port.calls
    .filter((call) => call.kind === "send" || call.kind === "edit")
    .map((call) => call.text);
  assert.equal(texts.length, 2);
  assert.match(texts[0] ?? "", lineRegExp("🧠"));
  const secondLines = String(texts[1]).split("\n");
  assert.equal(secondLines.length, 2);
  assert.match(secondLines[0] ?? "", lineRegExp("✓"));
  assert.match(secondLines[1] ?? "", lineRegExp("⏳"));
  assert.doesNotMatch(String(texts[1]), /thinking|web_search/u);
});

test("uses error icon for failed tools", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({ toolName: "web_search", callId: "c1" });
  await drain();
  publisher.onToolCompleted({ toolName: "web_search", callId: "c1" }, false);
  await drain();
  await publisher.finish(new AbortController().signal);

  const edit = port.calls.find((call) => call.kind === "edit");
  assert.match(edit?.text ?? "", lineRegExp("✗"));
});

test("never leaks tool input into the visible progress text", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({
    toolName: "static_page_fetch",
    callId: "c1",
    input: { url: "https://example.com/article?access_token=do-not-show" },
  });
  await drain();
  await publisher.finish(new AbortController().signal);

  const sent = port.calls.find((call) => call.kind === "send");
  assert.match(sent?.text ?? "", lineRegExp("⏳"));
  assert.doesNotMatch(
    String(sent?.text),
    /access_token|do-not-show|example\.com/u,
  );
});

test("research lookup hides its raw selector from the visible timeline", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({
    toolName: "research_lookup",
    callId: "c1",
    input: { query: "Иван Иванов phone +7 999 123-45-67" },
  });
  await drain();
  await publisher.finish(new AbortController().signal);

  const sent = port.calls.find((call) => call.kind === "send");
  assert.doesNotMatch(String(sent?.text), /Иван|999|123/u);
});

test("audio transcription shows only the fun label, never file/transcript details", async () => {
  const port = fakePort();
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({
    toolName: "audio_transcribe",
    callId: "audio-1",
    input: {
      source: "reply",
      file_id: "never-display-this",
      transcript: "и это тоже никогда не должно попасть в progress",
    },
  });
  await drain();
  await publisher.finish(new AbortController().signal);

  const sent = port.calls.find((call) => call.kind === "send");
  assert.doesNotMatch(
    String(sent?.text),
    /file_id|never-display|тоже никогда/u,
  );
});

test("recovers a stale message from a previous attempt", async () => {
  const port = fakePort();
  const store = fakeStore();
  const { publisher } = makePublisher({ port, store, initialMessageId: 42 });

  await publisher.recoverPrevious(new AbortController().signal);

  const deleteCall = port.calls.find((call) => call.kind === "delete");
  assert.equal(deleteCall?.messageId, 42);
  assert.ok(
    store.states.some((s) => s.turnId === 7 && s.progress.state === undefined),
  );
});

test("survives send/edit/delete failures without throwing", async () => {
  const port = fakePort({
    sendMessage: async () => ({ ok: false }),
    editMessageText: async () => ({ ok: false }),
    deleteMessage: async () => ({ ok: false }),
  });
  const { publisher } = makePublisher({ port });

  publisher.onToolStarted({ toolName: "day_digest", callId: "c1" });
  await drain();
  publisher.onToolCompleted({ toolName: "day_digest", callId: "c1" }, true);
  await drain();
  await publisher.finish(new AbortController().signal);

  assert.equal(port.calls.length, 2);
  assert.equal(port.calls[0].kind, "send");
  assert.equal(port.calls[1].kind, "send");
  assert.equal(publisher.state, "none");
});

test("renderProgressText joins statuses and truncates", () => {
  const pending = new Map([
    [
      "a",
      { kind: "tool" as const, label: "шаманю", state: "running" as const },
    ],
    ["b", { kind: "tool" as const, label: "колдую", state: "ok" as const }],
    ["c", { kind: "tool" as const, label: "мудрю", state: "error" as const }],
  ]);
  assert.equal(
    renderProgressText(pending, 100),
    "⏳ шаманю\n✓ колдую\n✗ мудрю",
  );

  const long = new Map([
    [
      "x",
      {
        kind: "tool" as const,
        label: "включаю режим детектива",
        state: "running" as const,
      },
    ],
  ]);
  const rendered = renderProgressText(long, 10);
  assert.equal(rendered.length, 10);
  assert.equal(rendered.at(-1), "…");
});
