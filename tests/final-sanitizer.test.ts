import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeFinalText } from "../src/bot/agent/final-sanitizer.js";
import { ReadToolEvidence } from "../src/bot/read-tools/contracts.js";

const allowedEvidence: ReadToolEvidence[] = [
  {
    source: "paper",
    chat: null,
    message: null,
    speaker: { id: null, name: null },
    date: "2026",
    title:
      "A randomized sleep phase advance protocol for circadian realignment",
    url: "https://example.org/paper/phase-advance",
    text: "A short abstract.",
  },
];

test("удаляет явно выдуманные ссылки с author+et al.", () => {
  const draft = [
    "Чек по источникам:",
    "Monterastelli et al. 2026 (вечерний свет убирает phase advance).",
    "Soehner & McClung 2026 (обзор).",
    "А это практический совет по сну.",
  ].join("\n");
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: [],
    researchMode: true,
    readToolFailures: [],
  });
  assert.equal(final.includes("Monterastelli"), false);
  assert.equal(final.includes("Soehner"), false);
  assert.equal(final.includes("А это практический совет"), true);
});

test("оставляет подтверждённые источники и убирает неподтверждённые ссылки", () => {
  const draft = [
    "Тут есть ссылка на пример:",
    "[paper](https://example.org/paper/phase-advance)",
    "И ложная ссылка: https://fake.example.ru/study",
  ].join("\n");
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: allowedEvidence,
    researchMode: true,
    readToolFailures: [],
  });
  assert.equal(final.includes("https://fake.example.ru/study"), false);
  assert.equal(final.includes("paper"), true);
  assert.equal(final.includes("Подтвержденные источники"), true);
});

test("в обычном режиме не меняет нормальный текст без источников", () => {
  const draft = "Никаких источников не нужно, просто совет.";
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: [],
    researchMode: false,
    readToolFailures: [],
  });
  assert.equal(final, draft);
});

test("убирает ложное сообщение о поломанном веб-поиске, если не было ошибки", () => {
  const draft = [
    "Веб-поиск сегодня лег, но paper_search отработал.",
    "Сейчас даю практический план.",
  ].join("\n");
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: allowedEvidence,
    researchMode: true,
    readToolFailures: [],
  });
  assert.equal(final.includes("Веб-поиск сегодня лег"), false);
  assert.equal(final.includes("Сейчас даю практический план"), true);
});

test("сохраняет сообщение о сломанном поиске, если это реально зафиксировано", () => {
  const draft = [
    "Веб-поиск сегодня лег.",
    "paper_search отработал с результатами.",
  ].join("\n");
  const final = sanitizeFinalText({
    text: draft,
    toolEvidence: allowedEvidence,
    researchMode: true,
    readToolFailures: [{ name: "web_search", code: "provider_error" }],
  });
  assert.equal(final.includes("Веб-поиск сегодня лег"), true);
  assert.equal(final.includes("paper_search отработал с результатами"), true);
});
