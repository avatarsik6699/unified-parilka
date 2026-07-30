import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  runDigestGeneration,
  type DigestSummaryPort,
  type DigestSummaryRequest,
  type DigestSummaryResult,
} from "../src/digests.js";
import {
  MessageStore,
  type StoredMessage,
} from "../src/store.js";

export const CHAT_ID = "-1001234567890";
export const NOW = new Date("2026-07-30T09:00:00.000Z");

export async function generate(
  store: MessageStore,
  summaryPort: DigestSummaryPort,
) {
  return await runDigestGeneration({
    store,
    chatId: CHAT_ID,
    apply: true,
    summaryPort,
    now: () => NOW,
  });
}

export class FakeSummaryPort implements DigestSummaryPort {
  readonly requests: DigestSummaryRequest[] = [];
  readonly #fail: (request: DigestSummaryRequest) => boolean;
  readonly #afterRequest: (
    request: DigestSummaryRequest,
  ) => void | Promise<void>;

  constructor(
    fail: (request: DigestSummaryRequest) => boolean = () => false,
    afterRequest: (
      request: DigestSummaryRequest,
    ) => void | Promise<void> = () => {},
  ) {
    this.#fail = fail;
    this.#afterRequest = afterRequest;
  }

  async summarize(
    request: DigestSummaryRequest,
  ): Promise<DigestSummaryResult> {
    this.requests.push(request);
    if (this.#fail(request)) {
      throw Object.assign(new Error("planned failure"), {
        code: "TEST_FAILURE",
      });
    }
    await this.#afterRequest(request);
    return {
      text: `${request.kind}:${request.period}:${request.sourceCount}:${this.requests.length}`,
      model: "secondary:summary-model",
      providerId: "secondary",
      inputTokens: request.sourceCount * 10,
      outputTokens: 5,
      fallbackCount: 0,
    };
  }

  count(kind: "day" | "week"): number {
    return this.requests.filter((request) => request.kind === kind)
      .length;
  }
}

export function makeStore(t: TestContext): {
  store: MessageStore;
  dbPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "parilka-digests-"));
  const dbPath = join(directory, "messages.sqlite");
  const store = new MessageStore(dbPath);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, dbPath };
}

export function seedMessages(
  store: MessageStore,
  messages: StoredMessage[],
): void {
  store.upsertMessages(
    {
      chatId: CHAT_ID,
      requested: CHAT_ID,
      title: "Test",
      kind: "supergroup",
    },
    messages,
  );
}

export function message(
  messageId: number,
  date: string,
  senderName: string,
  text: string,
): StoredMessage {
  return {
    chatId: CHAT_ID,
    messageId,
    date,
    senderId: String(messageId + 1_000),
    senderName,
    text,
  };
}
