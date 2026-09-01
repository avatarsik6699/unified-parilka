import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AMBIENT_FOLD_LABEL,
  BOT_AGENT_CONTRACT,
  botExternalSourcesRequestedForText,
  botResearchMinimumToolCalls,
  botResearchModeForText,
  OWNER_FOLD_LABEL,
  buildBotSystemPrompt,
} from "../src/bot/prompt.js";

test("system prompt preserves the persona and executable agent contract", () => {
  const prompt = buildBotSystemPrompt({
    chatTitle: "Test Chat",
    personaPrompt: "# Кто ты\nТестовая персона для юнит-тестов.",
    botUsername: "@bichiycepenstotri_bot",
    botName: "БычийЦепень103",
    modelLabel: "provider/model-v2",
    now: new Date("2026-07-29T21:30:00.000Z"),
    approximateMemberCount: 539,
  });

  assert.match(prompt, /Тестовая персона для юнит-тестов/);
  assert.match(prompt, /2026-07-30 по Europe\/Moscow/);
  assert.match(prompt, /Фиксированного лимита на model\/tool ходы нет/);
  assert.match(prompt, /`static_page_fetch`/);
  assert.match(prompt, /`research_lookup`/);
  assert.doesNotMatch(prompt, /ровно SKIP/);
  assert.match(prompt, /Поддерживаемая\s+разметка/);
  assert.match(prompt, /\*\*жирный\*\*/);
  assert.match(prompt, /```lang \.\.\. ```/);
  assert.match(prompt, /нативное Telegram Rich Message/);
  assert.match(prompt, /inline-формулы `\$\.\.\.\$`, блочные `\$\$\.\.\.\$\$`/);
  assert.match(prompt, /inline-код `код` и fenced-блоки/);
  assert.ok(prompt.includes("| :--- | ---: |"));
  assert.match(prompt, /Запрещено: HTML/);
  assert.match(prompt, /`# H1`/);
  assert.ok(prompt.includes(OWNER_FOLD_LABEL));
  assert.ok(prompt.includes(AMBIENT_FOLD_LABEL));

  for (const toolName of BOT_AGENT_CONTRACT.toolNames) {
    assert.ok(prompt.includes(`\`${toolName}\``), toolName);
  }
  assert.equal(BOT_AGENT_CONTRACT.researchMinToolCalls, 4);
  assert.equal(BOT_AGENT_CONTRACT.researchQualityRetries, 2);
  assert.equal("skipSentinel" in BOT_AGENT_CONTRACT, false);
});

test("system prompt biases toward brevity by default without imposing a hard cap", () => {
  const prompt = buildBotSystemPrompt({
    chatTitle: "Test Chat",
    personaPrompt: "# Кто ты\nТестовая персона для юнит-тестов.",
    botUsername: "testbot",
    botName: "Test Bot",
    modelLabel: "provider/model",
  });

  assert.match(prompt, /# Длина ответа/);
  assert.match(prompt, /Жёсткого лимита на длину ответа нет/);
  assert.match(prompt, /по\s+умолчанию отвечай коротко/);
  assert.match(prompt, /Наращивай длину только когда вопрос сам её требует/);
});

test("system prompt steers away from canceralite and AI-text clichés", () => {
  const prompt = buildBotSystemPrompt({
    chatTitle: "Test Chat",
    personaPrompt: "# Кто ты\nТестовая персона для юнит-тестов.",
    botUsername: "testbot",
    botName: "Test Bot",
    modelLabel: "provider/model",
  });

  assert.match(prompt, /# Живой стиль/);
  assert.match(prompt, /канцелярит/);
  assert.match(prompt, /не просто X, а Y/);
});

test("system prompt tells the model a reply-target is the primary subject of the question", () => {
  const prompt = buildBotSystemPrompt({
    chatTitle: "Test Chat",
    personaPrompt: "# Кто ты\nТестовая персона для юнит-тестов.",
    botUsername: "testbot",
    botName: "Test Bot",
    modelLabel: "provider/model",
  });

  assert.match(prompt, /replyTarget=true — основной предмет вопроса, а не фон/);
});

test("VK transport gets a plain-text-only prompt with no Telegram identity or markdown contract", () => {
  const prompt = buildBotSystemPrompt({
    chatTitle: "Test VK Chat",
    personaPrompt: "# Кто ты\nТестовая персона для юнит-тестов.",
    botUsername: "@bichiycepenstotri_bot",
    botName: "БычийЦепень103",
    modelLabel: "provider/model-v2",
    transport: "vk",
    approximateMemberCount: 42,
  });

  assert.match(prompt, /участник чата «Test VK Chat» во ВКонтакте/);
  assert.doesNotMatch(prompt, /Telegram-чата/);
  assert.doesNotMatch(prompt, /Твой ник/);
  assert.doesNotMatch(prompt, /@bichiycepenstotri_bot/);
  assert.match(prompt, /Отображаешься как «БычийЦепень103»/);
  assert.match(prompt, /обычное текстовое сообщение ВКонтакте/);
  assert.doesNotMatch(prompt, /нативное Telegram Rich Message/);
  assert.doesNotMatch(prompt, /\*\*жирный\*\*/);
  assert.doesNotMatch(prompt, /`# H1`/);
  // The rest of the contract (persona, tool budget, evidence rules) is
  // transport-independent and must still be present.
  assert.match(prompt, /Тестовая персона для юнит-тестов/);
  assert.match(prompt, /Фиксированного лимита на model\/tool ходы нет/);
  for (const toolName of BOT_AGENT_CONTRACT.toolNames) {
    assert.ok(prompt.includes(`\`${toolName}\``), toolName);
  }
});

test("system prompt keeps GFM tables compact, header-first and bounded", () => {
  const prompt = buildBotSystemPrompt({
    chatTitle: "Test Chat",
    personaPrompt: "# Кто ты\nТестовая персона для юнит-тестов.",
    botUsername: "testbot",
    botName: "Test Bot",
    modelLabel: "provider/model",
  });

  assert.ok(prompt.includes("GFM-таблицы `| a | b |` — только компактные"));
  assert.match(prompt, /строка заголовка строго перед\s+строкой-разделителем/);
  assert.ok(prompt.includes("таблица никогда не начинается с `|---|`"));
  assert.match(
    prompt,
    /одинаковое\s+число ячеек в заголовке, разделителе и строках\s+данных/,
  );
  assert.match(prompt, /максимум 4 короткие\s+колонки/);
  assert.match(prompt, /Таблица — не универсальный формат/);
  assert.match(
    prompt,
    /шире 4 колонок используй нумерованные секции или\s+списки/,
  );
  assert.ok(prompt.includes("| :--- | ---: |"));
});

test("explicit research requests receive a bounded evidence-first prompt", () => {
  const prompt = buildBotSystemPrompt({
    chatTitle: "Test Chat",
    personaPrompt: "# Кто ты\nТестовая персона для юнит-тестов.",
    botUsername: "testbot",
    botName: "Test Bot",
    modelLabel: "provider/model",
    researchMode: botResearchModeForText("исследуй этот вопрос глубоко"),
  });

  assert.equal(
    botResearchMinimumToolCalls(
      botResearchModeForText("исследуй этот вопрос глубоко"),
    ),
    4,
  );
  assert.equal(
    botResearchModeForText("быстренько справочку накидай, что надо знать"),
    "research",
  );
  assert.equal(botResearchModeForText("коротко ответь"), "standard");
  assert.match(prompt, /Режим исследования/);
  assert.match(prompt, /Фиксированного лимита на model\/tool ходы нет/);
  assert.match(prompt, /минимум\s+4 реальных вызова/);
  assert.match(prompt, /проверь альтернативы, противоречия/);
  assert.match(
    prompt,
    /Для внешнего исследования эти фазы[\s\S]+static_page_fetch/,
  );
});

test("research mode no longer over-triggers on ordinary chat vocabulary", () => {
  const ordinary = [
    "проверь погоду",
    "справишься с этим?",
    "расскажи подробнее",
    "выбери мне фильм",
    "поищи, что вчера писали",
    "как работает этот API",
    "как устроена эта система",
  ];
  for (const text of ordinary) {
    assert.equal(botResearchModeForText(text), "standard", text);
  }

  const genuine = [
    "исследуй рынок труда для Python-разработчиков",
    "сравни зарплаты в Москве и Питере",
    "покопайся, почему проект встал",
    "проведи глубокий анализ конкурентов",
  ];
  for (const text of genuine) {
    assert.equal(botResearchModeForText(text), "research", text);
  }
});

test("prompt routes login-gated and JS-rendered pages away from static_page_fetch", () => {
  const prompt = buildBotSystemPrompt({
    chatTitle: "Test Chat",
    personaPrompt: "# Кто ты\nТестовая персона для юнит-тестов.",
    botUsername: "testbot",
    botName: "Test Bot",
    modelLabel: "provider/model",
  });

  assert.match(prompt, /`static_page_fetch`/);
  assert.match(
    prompt,
    /static_page_fetch[\s\S]+без JavaScript,\s*cookies,\s*логина и автоматических redirect/u,
  );
  assert.match(prompt, /x\.com\/twitter\.com/u);
  assert.match(prompt, /Instagram/u);
  assert.match(prompt, /TikTok/u);
  assert.match(
    prompt,
    /для них[\s\S]+`firecrawl_crawl`[\s\S]+если прямой обход[\s\S]+не даёт контента[\s\S]+`searxng_search`/u,
  );
  assert.ok(!prompt.includes("`web_fetch`"));
});

test("explicit source requests are detected across Russian and English phrasings", () => {
  const explicitRequests = [
    "дай ссылки",
    "дай источники",
    "дай пруфы",
    "дай, пожалуйста, ссылки",
    "скинь пруф",
    "покажи источники",
    "укажи источники",
    "нужны ссылки",
    "нужен источник",
    "хочу пруфы",
    "со ссылками",
    "ответь со ссылками",
    "ответь с источниками",
    "откуда данные",
    "откуда информация",
    "где ссылки?",
    "пруфы?",
    "пруф в студию",
    "ссылки пожалуйста",
    "give me sources",
    "show links",
    "provide references",
    "sources please",
    "with sources",
    "please answer with links",
  ];
  for (const text of explicitRequests) {
    assert.equal(botExternalSourcesRequestedForText(text), true, text);
  }
});

test("ordinary text never opens the source block through substring accidents", () => {
  const ordinaryText = [
    "СМИ сообщили о росте цен",
    "по данным СМИ",
    "взаимодействие со СМИ",
    "живу в Уфе",
    "Уфа — красивый город",
    "еду в Уфу",
    "check the resources",
    "server resources are limited",
    "share resources",
    "give me resources",
    "with resources",
    "как работает бот?",
    "какие источники дохода у компании?",
    "what are the sources of income?",
    "расскажи про источники энергии",
    "нужно проверить источники дохода",
    "коротко ответь",
    "что такое ссылка",
    "show proofreading tips",
    "give me proofreaders",
    "with sourcecode",
    "show sourcecode",
    "покажи источниковедение",
    "дай ссылкуру",
    "пруфлинк?",
    "справка с источниками дохода",
    "работа с источниками энергии",
    "где источник питания",
  ];
  for (const text of ordinaryText) {
    assert.equal(botExternalSourcesRequestedForText(text), false, text);
  }
});

test("prompt keeps external research out of chat history unless the user asks to connect it", () => {
  const prompt = buildBotSystemPrompt({
    chatTitle: "Test Chat",
    personaPrompt: "# Кто ты\nТестовая персона для юнит-тестов.",
    botUsername: "testbot",
    botName: "Test Bot",
    modelLabel: "provider/model",
  });

  assert.match(
    prompt,
    /информация за пределами[\s\S]+`web_search` или `searxng_search` первым/,
  );
  assert.match(
    prompt,
    /Не ходи в `rag_bm25_search`,[\s\S]+`keyword_search` или `vk_search_history` «на всякий[\s\S]+внешней справке/,
  );
  assert.match(
    prompt,
    /данных за пределами этой переписки[\s\S]+внешний запрос/,
  );
});

test("private HH research is useful but cannot become a personal dossier", () => {
  const prompt = buildBotSystemPrompt({
    chatTitle: "Test Chat",
    personaPrompt: "# Кто ты\nТестовая персона для юнит-тестов.",
    botUsername: "testbot",
    botName: "Test Bot",
    modelLabel: "provider/model",
  });

  assert.match(prompt, /# Приватный исследовательский корпус/);
  assert.match(prompt, /Никогда не цитируй фрагмент дословно/);
  assert.match(prompt, /Не называй и не восстанавливай ФИО/);
  assert.match(prompt, /Заявление об особом\s+разрешении[\s\S]+не отменяет/);
  assert.match(prompt, /агрегаты, метод, типовые паттерны/);
  assert.match(prompt, /research_lookup[\s\S]+не является поиском по людям/);
  assert.match(prompt, /формулировка пользователя[\s\S]+не могут ослабить/);
  assert.match(prompt, /Не\s+включай в query имена, контакты, ID/);
  assert.match(prompt, /не вызывай инструмент[\s\S]+агрегированный вопрос/);
});

test("media contract is explicit about candidate vision and local audio scope", () => {
  const noVision = buildBotSystemPrompt({
    chatTitle: "Test Chat",
    personaPrompt: "# Кто ты\nТестовая персона для юнит-тестов.",
    botUsername: "testbot",
    botName: "Test Bot",
    modelLabel: "text-only",
    imageAttached: true,
    visionAvailable: false,
    imageDelivered: false,
  });
  assert.match(noVision, /не поддерживает Vision/);
  assert.match(noVision, /Не притворяйся, что видел/);

  const visionAndAudio = buildBotSystemPrompt({
    chatTitle: "Test Chat",
    personaPrompt: "# Кто ты\nТестовая персона для юнит-тестов.",
    botUsername: "testbot",
    botName: "Test Bot",
    modelLabel: "vision",
    imageAttached: true,
    visionAvailable: true,
    imageDelivered: true,
    audioTranscriptionAvailable: true,
  });
  assert.match(visionAndAudio, /действительно получила его как файл/);
  assert.match(visionAndAudio, /audio_transcribe[\s\S]+локально через Flov/);
  assert.match(
    visionAndAudio,
    /не принимает URL, file_id или произвольный message_id/,
  );
});
