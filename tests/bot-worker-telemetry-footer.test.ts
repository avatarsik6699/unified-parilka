import assert from "node:assert/strict";
import { test } from "node:test";
import { final, makeFixture } from "./support/bot-worker.js";

test("telemetryFooter: false publishes the bare model text with no footer", async (t) => {
  const fixture = makeFixture(t);
  const finalText = "Готовый безопасный ответ без подвала";
  let publishedText: string | undefined;
  const worker = fixture.worker({
    telemetryFooter: false,
    agent: async () => final(finalText),
    publisher: async (request) => {
      publishedText =
        request.publication.mode === "rich" ||
        request.publication.mode === "plain"
          ? request.publication.plainText
          : undefined;
      return { ok: true, chunksSent: 1, telegramMessageId: 9_001 };
    },
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, {
    status: "sent",
    turnId: fixture.turnId,
    telegramMessageId: 9_001,
  });
  assert.equal(publishedText, finalText);
  assert.equal(fixture.store.getBotTurn(fixture.turnId)?.draftText, finalText);
});
