import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TELEGRAM_TEXT_LIMIT_UTF16,
  guardApplicationPlainTelegramOutput,
  guardFinalTelegramOutput,
  splitTelegramText,
  utf16Length,
  type GuardedTelegramPublication,
  type OutputGuardPolicy,
  type OutputGuardResult,
} from "../src/bot/output-guards.js";

interface GuardCase {
  name: string;
  text: string;
  policy?: OutputGuardPolicy;
  verify: (result: OutputGuardResult) => void;
}

const guardCases: GuardCase[] = [
  {
    name: "emoji keep a lossless full plain projection and UTF-16-safe split",
    text: "🔥".repeat(3_000),
    verify(result) {
      const sent = expectSend(result);
      assert.equal(sent.publication.mode, "rich");
      const plainText = sent.text;
      assert.equal(utf16Length(plainText), 6_000);
      const chunks = splitTelegramText(plainText);
      assert.equal(chunks.length, 2);
      assert.equal(chunks.join(""), plainText);
      assert.ok(chunks.every((chunk) => utf16Length(chunk) <= 4_096));
      assert.ok(chunks.every(hasNoUnpairedSurrogates));
    },
  },
  {
    name: "one token longer than Telegram limit keeps a lossless plain split",
    text: "x".repeat(9_000),
    verify(result) {
      const sent = expectSend(result);
      assert.equal(sent.publication.mode, "rich");
      assert.equal(sent.text, "x".repeat(9_000));
      assert.deepEqual(
        splitTelegramText(sent.text).map(utf16Length),
        [4_096, 4_096, 808],
      );
      assert.equal(splitTelegramText(sent.text).join(""), sent.text);
    },
  },
  {
    name: "think blocks, dangling reasoning tails, sentinels, and internal ordinals are removed",
    text:
      "<think>do not publish this</think>\nОтвет: сообщение #1234 готово.<thinking>hidden tail",
    verify(result) {
      const sent = expectSend(result);
      assert.equal(sent.text, "Ответ: готово.");
      assert.equal(sent.report.removedHiddenBlocks, 2);
      assert.equal(sent.report.removedServiceArtifacts, 1);
      assert.doesNotMatch(sent.text, /think|1234/iu);
    },
  },
  {
    name: "a mismatched attributed quote is terminal",
    text: "Алиса: «это достаточно длинная дословная цитата»",
    policy: {
      evidence: [
        {
          speaker: "Боб",
          text: "Вчера Боб написал: это достаточно длинная дословная цитата.",
        },
      ],
    },
    verify(result) {
      expectRejection(result, "quote_speaker_mismatch");
    },
  },
  {
    name: "an allowlisted Telegram mention is preserved",
    text: "@alice спасибо за уточнение",
    policy: { allowedMentions: ["alice"] },
    verify(result) {
      const sent = expectSend(result);
      assert.equal(sent.text, "@alice спасибо за уточнение");
      assert.deepEqual(sent.report.mentions, ["@alice"]);
    },
  },
  {
    name: "a non-allowlisted Telegram mention rejects the complete output",
    text: "@mallory посмотри сюда",
    policy: { allowedMentions: ["alice"] },
    verify(result) {
      expectRejection(result, "unauthorized_mention");
      assert.equal("text" in result, false);
      assert.equal("publication" in result, false);
    },
  },
  {
    name: "exact SKIP remains a no-send result",
    text: " \nSKIP\n ",
    verify(result) {
      assert.deepEqual(result, {
        ok: true,
        disposition: "skip",
        text: "SKIP",
        report: {
          removedHiddenBlocks: 0,
          removedServiceArtifacts: 0,
          verifiedQuotes: 0,
          mentions: [],
        },
      });
    },
  },
];

for (const guardCase of guardCases) {
  test(guardCase.name, () => {
    const result = guardFinalTelegramOutput(
      { kind: "final", text: guardCase.text },
      guardCase.policy,
    );
    guardCase.verify(result);
  });
}

test("matching structured speaker and verbatim text verifies a quote", () => {
  const result = guardFinalTelegramOutput(
    {
      kind: "final",
      text: "Как сказала Алиса: «Это достаточно длинная дословная цитата».",
    },
    {
      evidence: [
        {
          speaker: "Алиса",
          text: "это достаточно длинная\nдословная цитата",
        },
      ],
    },
  );

  const sent = expectSend(result);
  assert.equal(sent.report.verifiedQuotes, 1);
});

test("quote attribution after an em dash is verified", () => {
  const result = guardFinalTelegramOutput(
    {
      kind: "final",
      text: "«Это ещё одна достаточно длинная цитата» — Алиса.",
    },
    {
      evidence: [
        {
          speaker: "Алиса",
          text: "Это ещё одна достаточно длинная цитата",
        },
      ],
    },
  );

  assert.equal(expectSend(result).report.verifiedQuotes, 1);
});

test("an unattributed quote without evidence is allowed", () => {
  const text = "В тексте встречается «полностью выдуманная длинная цитата» без атрибуции.";
  const result = guardFinalTelegramOutput(
    { kind: "final", text },
    { evidence: [] },
  );

  const sent = expectSend(result);
  assert.equal(sent.report.verifiedQuotes, 0);
  assert.match(sent.text, /полностью выдуманная длинная цитата/u);
});

test("a page-title label before a quote is not treated as a chat speaker", () => {
  const result = guardFinalTelegramOutput(
    { kind: "final", text: "Заголовок страницы: «Example Domain»." },
    {
      evidence: [{ speaker: "Боб", text: "Боб написал совсем другое." }],
    },
  );

  assert.equal(expectSend(result).report.verifiedQuotes, 0);
});

test("an all-caps external source after a quote is not treated as a chat speaker", () => {
  const result = guardFinalTelegramOutput(
    { kind: "final", text: "«Example Domain» — IANA." },
    {
      evidence: [{ speaker: "Боб", text: "Боб написал совсем другое." }],
    },
  );

  assert.equal(expectSend(result).report.verifiedQuotes, 0);
});

test("more than two mentions rejects even when every username is allowlisted", () => {
  const result = guardFinalTelegramOutput(
    { kind: "final", text: "@alice @bobby @carol общий ответ" },
    {
      allowedMentions: ["alice", "bobby", "carol"],
      maxMentions: 2,
    },
  );

  const rejection = expectRejection(result, "mass_mentions");
  assert.equal(rejection.details?.count, 3);
});

test("repeating one authorized username does not count as a mass mention", () => {
  const result = guardFinalTelegramOutput(
    { kind: "final", text: "@alice ответил выше, @Alice глянь ещё раз" },
    { allowedMentions: ["alice"], maxMentions: 1 },
  );

  assert.deepEqual(expectSend(result).report.mentions, ["@Alice"]);
});

test("markdown-bold mention bypass is rejected on visible text", () => {
  const result = guardFinalTelegramOutput(
    { kind: "final", text: "@foo**bar** привет" },
    { allowedMentions: [] },
  );

  expectRejection(result, "unauthorized_mention");
});

test("Telegram-only spoiler and marked syntax cannot materialize an unseen mention", () => {
  for (const text of ["@al||ice||", "@al==ice=="]) {
    const result = guardFinalTelegramOutput(
      { kind: "final", text },
      { allowedMentions: [] },
    );
    const sent = expectSend(result);
    assert.deepEqual(sent.publication, {
      mode: "plain",
      plainText: text,
      maxChunkUtf16: TELEGRAM_TEXT_LIMIT_UTF16,
    });
    assert.deepEqual(sent.report.mentions, []);
  }
});

test("unauthorized mentions inside code spans still reject on visible text", () => {
  const text =
    "Вот код:\n```ts\n  const value  = \"a long quoted string value\";\n  message #1234\n  @decorator\n```\nИ `@inline_name` тоже код.";
  const result = guardFinalTelegramOutput(
    { kind: "final", text },
    { allowedMentions: [] },
  );

  expectRejection(result, "unauthorized_mention");
});

test("quotes inside code spans pass without rejection when unattributed", () => {
  const result = guardFinalTelegramOutput(
    {
      kind: "final",
      text: 'Пример: `const value = "полностью выдуманная длинная цитата"`.',
    },
    {},
  );

  const sent = expectSend(result);
  assert.equal(sent.report.verifiedQuotes, 0);
});

test("rich markdown with a table and formulas is published unchanged", () => {
  const markdown = [
    "| Метрика | Значение |",
    "| --- | --- |",
    "| Инлайн | $E = mc^2$ |",
    "",
    "Блок:",
    "$$\\int_a^b f(x)\\,dx$$",
  ].join("\n");
  const result = guardFinalTelegramOutput({ kind: "final", text: markdown }, {});

  const sent = expectSend(result);
  assert.deepEqual(sent.publication, {
    mode: "rich",
    markdown,
    plainText: sent.text,
    maxChunkUtf16: TELEGRAM_TEXT_LIMIT_UTF16,
  });
  assert.match(sent.text, /Инлайн/);
  assert.match(sent.text, /E = mc\^2/);
});

test("unsafe link forces whole-message plain publication", () => {
  const result = guardFinalTelegramOutput(
    { kind: "final", text: "до [клик](tg://user?id=1) после" },
    {},
  );

  const sent = expectSend(result);
  assert.deepEqual(sent.publication, {
    mode: "plain",
    plainText: "до клик после",
    maxChunkUtf16: TELEGRAM_TEXT_LIMIT_UTF16,
  });
  assert.equal(sent.text, "до клик после");
});

test("raw html forces whole-message plain publication", () => {
  const result = guardFinalTelegramOutput(
    { kind: "final", text: "<b>жирный</b>" },
    {},
  );

  const sent = expectSend(result);
  assert.deepEqual(sent.publication, {
    mode: "plain",
    plainText: "жирный",
    maxChunkUtf16: TELEGRAM_TEXT_LIMIT_UTF16,
  });
  assert.equal(sent.text, "жирный");
});

test("blockquote with code stays a native rich publication", () => {
  const result = guardFinalTelegramOutput(
    { kind: "final", text: "> `код` и текст" },
    {},
  );

  const sent = expectSend(result);
  assert.equal(sent.publication.mode, "rich");
  assert.equal(sent.text, "код и текст");
});

test("code spans keep their content in the canonical plain text", () => {
  const text =
    "Вот код:\n```ts\n  const value  = 42;\n  message #1234\n```\nИ `inline_name` тоже код.";
  const result = guardFinalTelegramOutput({
    kind: "final",
    text,
  });

  const sent = expectSend(result);
  assert.equal(sent.publication.mode, "rich");
  assert.match(sent.text, /  const value  =/u);
  assert.match(sent.text, /message #1234/u);
  assert.deepEqual(sent.report.mentions, []);
  assert.equal(sent.report.verifiedQuotes, 0);
});

test("SKIP with additional text is ordinary output, not a silent skip", () => {
  const result = guardFinalTelegramOutput({
    kind: "final",
    text: "SKIP — но вот ответ",
  });

  const sent = expectSend(result);
  assert.equal(sent.text, "SKIP — но вот ответ");
});

test("a fully hidden answer is rejected rather than treated as model-requested SKIP", () => {
  const result = guardFinalTelegramOutput({
    kind: "final",
    text: "<analysis>only private reasoning</analysis>",
  });

  expectRejection(result, "empty_after_sanitization");
});

test("malformed UTF-16 is rejected before the publication boundary", () => {
  const result = guardFinalTelegramOutput({
    kind: "final",
    text: `ответ \ud83d без второй половины`,
  });

  expectRejection(result, "invalid_unicode");
});

test("restored policy validation rejects invalid chunk and quote bounds", () => {
  expectRejection(
    guardFinalTelegramOutput(
      { kind: "final", text: "ответ" },
      { maxChunkUtf16: 1 },
    ),
    "invalid_policy",
  );
  expectRejection(
    guardFinalTelegramOutput(
      { kind: "final", text: "ответ" },
      { minQuoteCharacters: 0 },
    ),
    "invalid_policy",
  );
});

test("the validated fallback chunk bound crosses the publication boundary", () => {
  const result = guardFinalTelegramOutput(
    { kind: "final", text: `<b>${"x".repeat(200)}</b>` },
    { maxChunkUtf16: 64 },
  );

  const sent = expectSend(result);
  assert.deepEqual(sent.publication, {
    mode: "plain",
    plainText: "x".repeat(200),
    maxChunkUtf16: 64,
  });
});

test("an application-owned local transcript stays plain but neutralizes Telegram mentions and links", () => {
  const transcript = `Коля: «длинная фраза из голосового, которую нельзя выдавать за модельную цитату»\n@somename https://example.test/path, t.me/channel, person@example.test ${"x".repeat(5_000)}`;
  const result = guardApplicationPlainTelegramOutput(
    { kind: "final", text: transcript },
  );

  const sent = expectSend(result);
  const expected = transcript
    .replaceAll("@somename", "@\u2060somename")
    .replaceAll("https:", "https:\u2060")
    .replaceAll("example.test", "example.\u2060test")
    .replaceAll("t.me", "t.\u2060me")
    .replaceAll("person@", "person@\u2060");
  assert.deepEqual(sent.publication, {
    mode: "plain",
    plainText: expected,
    maxChunkUtf16: TELEGRAM_TEXT_LIMIT_UTF16,
  });
  assert.doesNotMatch(sent.text, /@[a-z][a-z0-9_]{4,31}\b/iu);
  assert.doesNotMatch(sent.text, /https:\/\//iu);
  assert.doesNotMatch(sent.text, /\bt\.me\//iu);
  assert.deepEqual(splitTelegramText(sent.text).join(""), expected);
});

test("normal model plain publication is not rewritten by local transcript entity hardening", () => {
  const result = guardFinalTelegramOutput(
    { kind: "final", text: "@alice https://example.test/path" },
    { allowedMentions: ["alice"] },
  );

  const sent = expectSend(result);
  assert.equal(sent.publication.mode, "rich");
  assert.equal(sent.text, "@alice https://example.test/path");
});

test("splitter preserves paragraph whitespace and never exceeds a conservative limit", () => {
  const text = `${"абзац ".repeat(40)}\n\n${"🔥".repeat(80)}`;
  const chunks = splitTelegramText(text, 128);

  assert.equal(chunks.join(""), text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => utf16Length(chunk) <= 128));
  assert.ok(chunks.every(hasNoUnpairedSurrogates));
  assert.equal(TELEGRAM_TEXT_LIMIT_UTF16, 4_096);

  const boundaryPair = splitTelegramText("abc\n\nx", 4);
  assert.equal(boundaryPair.join(""), "abc\n\nx");
  assert.ok(boundaryPair.every((chunk) => utf16Length(chunk) <= 4));
});

function expectSend(
  result: OutputGuardResult,
): Extract<OutputGuardResult, { ok: true; disposition: "send" }> & {
  publication: GuardedTelegramPublication;
} {
  assert.equal(
    result.ok && result.disposition,
    "send",
    result.ok ? `unexpected disposition: ${result.disposition}` : result.rejection.message,
  );
  return result as Extract<
    OutputGuardResult,
    { ok: true; disposition: "send" }
  >;
}

function expectRejection(
  result: OutputGuardResult,
  code: Extract<OutputGuardResult, { ok: false }>["rejection"]["code"],
): Extract<OutputGuardResult, { ok: false }>["rejection"] {
  if (result.ok) {
    assert.fail(`expected ${code}, received ${result.disposition}`);
  }
  assert.equal(result.rejection.code, code);
  return result.rejection;
}

function hasNoUnpairedSurrogates(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
