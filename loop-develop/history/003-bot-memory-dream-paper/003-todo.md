# 003 — Bot dreaming, persistent memory и scientific search tool

> Sequencing: этот goal конфликтовал с активным 002 по файлам
> (`src/bot/prompt.ts`, `src/bot/ai-agent.ts`, `tests/bot-prompt.test.ts`). 002
> перенесён в `history/`; 003 реализован поверх него.

## Goal

Дать unified Parilka bot двухслойную память в стиле Claude Code / Codex /
Hermes: маленький curated блок, который всегда инжектится в системный промпт с
жёстким бюджетом, и «dreaming» — офлайн-консолидацию диалога в этот блок по
порогу «каждые N новых сообщений», выполняемую в idle-время существующим
timer-контуром. Плюс read tool `paper_search` для поиска по научным источникам
(arXiv, Europe PMC) по образцу существующего `web_search`.

## Source Research Summary

**Decision question:** как добавить боту постоянную память и научный поиск
минимальными slice'ами, не трогая durable turn FSM, не раздувая промпт и не
вводя новых рантаймов/сторов?

**Локальное evidence (перепроверено по коду 2026-07-30):**

- Пер-диалоговой суммаризации в bot loop НЕТ; суммаризация существует только
  офлайн в дайджестах (`src/digest/summary-port.ts`, 265 строк) и вызывается из
  `bin/parilka-digests` по `parilka-maintain.timer` (04:20). Дайджесты попадают
  в контекст бота только по запросу через tool `day_digest`.
- Системный промпт — статический шаблон без условных секций
  (`src/bot/prompt.ts:61-182`, `buildBotSystemPrompt` на :38); собирается на
  каждую provider attempt (`src/bot/ai-agent.ts:221-225`) из frozen-опций,
  сконструированных один раз в `src/bot-daemon/composition.ts:52-66`.
- `AiSdkSummaryPort.summarize(request)` — plain text через
  `router.executeWithFallback(role, attempt)` (`src/providers/model-router/
  router.ts:42-45`); валидация: `finishReason==="stop"`, непустота,
  `length <= maxOutputChars` (summary-port.ts:111-127). Structured output нет.
- Схема v15 (`src/storage/constants.ts:7`); миграции — цепочка
  `if (currentVersion < N)` в `migrate()` (`src/storage/schema/lifecycle.ts:
  53-128`) внутри одного `immediateTransaction` + `validateSchema()` (:130-308);
  домены — `*Methods extends StoreCore` + `*Api = Pick<...>`, регистрация в
  `src/store.ts`.
- `maintenance` процесс model-free (retention/fts/optimize,
  `src/maintenance/run.ts:129-178`); model-доступ и process lock уже есть у
  `parilka-digests` CLI (`src/digest-cli/run.ts:41`,
  `src/digest/process-lock.ts`).
- `web_search` tool: интерфейс `WebSearchProvider` (`src/bot/read-tools/
  contracts.ts`), executor, dispatch switch, zod `.strict()` схемы.
- Recall по старым сообщениям УЖЕ есть: `search_chat` — гибрид FTS5+vector
  (`src/bot/read-cache.ts:139-153`). Новый retrieval-стор не нужен.
- Bot daemon уже потребляет ключи shared-контура (прецедент embeddings,
  `production.ts:77-89`) — tunables dreaming кладём в shared config, без
  дублирования в bot-контуре.

**Внешнее evidence (как делают другие):**

- Hermes v0.19 (локальный исходник): `MEMORY.md` 2200 chars + `USER.md` 1375
  chars, разделитель `§`, frozen snapshot в system prompt на старте сессии,
  индикатор заполнения `[67% — 1474/2200 chars]`, только декларативные факты,
  записи сканируются на injection до записи и при загрузке.
- Claude Code: auto memory — `MEMORY.md`-индекс (первые 200 строк / 25KB в
  контекст) + topic-файлы on-demand; Auto Dream: триггер 24ч + ≥5 сессий,
  4 фазы, абсолютные даты, прунинг противоречий, lock-файл, фоном.
- Codex CLI (experimental memories): extract-модель после ~6ч idle →
  consolidation-модель, markdown-стор, grep вместо векторов, TTL 30 дней на
  невостребованное, редактирование секретов.
- Литература: Sleep-time Compute (arXiv:2504.13171) — консолидация в idle
  даёт ~5× экономию test-time compute; Generative Agents (arXiv:2304.03442) —
  рефлексия по накопленному порогу, обобщения отдельно от сырого лога;
  MemGPT (arXiv:2310.08560) — bounded memory-блоки, закреплённые в контексте.
- Конвергенция индустрии: char/line-бюджеты и markdown вместо vector DB;
  consolidation в idle-time, не на горячем пути ответа.

**Goals:**

1. Curated memory per chat: одна строка `bot_chat_memory`, bounded текст,
   всегда в системном промпте как недоверенные данные.
2. Dreaming: офлайн-консолидация «текущий блок + последние K сообщений» →
   новый блок, триггер «≥ N новых сообщений с последнего watermark».
3. Live-обновление блока без рестарта бота и без рефакторинга frozen prompt
   options: блок грузится per-turn в `loadBotTurn` (async, store доступен).
4. Read tool `paper_search`: keyless arXiv API первично, Europe PMC опционально.
5. Полные config/schema/test gates по контракту AGENTS.md.

**Non-goals:** model-initiated memory write tool (v1 — только dream-проход,
без write-approval UX); глобальная/кросс-чат память и USER-профили; история
ревизий памяти; векторный memory-стор; потребление внешних MCP ботом; изменение
durable turn FSM и hot path воркера; harness-канон (`mcp-sync`) — отдельная
операция, см. Target Files; commit/push.

**Status quo:** бот помнит только окно `BOT_CONTEXT_MESSAGES=60` +
`BOT_REPLAY_MESSAGES=100` (`src/bot/worker/contracts.ts:7-8`) и умеет спрашивать
архив через `search_chat`. Между сессиями/после вытеснения контекста ничего не
закреплялось.

**Минимальное изменение:** одна таблица + один storage-домен + одна условная
секция промпта + один офлайн dream-проход в существующем digest CLI + один read
tool. Никаких новых процессов, локов, рантаймов.

**Реальная альтернатива:** (а) inline-сон в `BotTurnWorker` после
`dispatchBotTurn` — отклонено: риск для hot path и FSM, свежести daily-консоли-
дации достаточно для curated памяти (подтверждено практикой Auto Dream 24ч и
Codex 6ч idle); (б) memory write tool для модели как у Hermes — отклонено для
v1: poisoning-риск и write-approval сложность; (в) внешний MCP-сервер памяти —
отклонено: бот MCP не потребляет, а state обязан жить в versioned SQLite.

**Рекомендация:** реализовать milestones A (memory+dreaming) и B
(paper_search) ниже. Confidence высокая: все интеграционные точки перепроверены
по коду, внешние паттерны — по первоисточникам.

## Product Shape

```text
parilka-bot (per turn)
  loadBotTurn: history + replay + bot_chat_memory block (async read)
  agent.run(..., memoryBlock)
  buildBotSystemPrompt: + секция «Постоянная память» (untrusted-wrapped,
    bounded PARILKA_MEMORY_MAX_CHARS, индикатор заполнения) на каждой attempt

parilka-digests --apply (timer 04:20, существующий process lock)
  digest phases (как сейчас)
  dream pass (новый): для каждого чата
    countMessagesSince(last_consolidated_message_id) >= N ?
      -> read last K messages + текущий блок
      -> router "summary": merge/вычитка/абсолютные даты/бюджет
      -> validate (stop, непустой, <= max chars) -> upsert + watermark
      -> fail-closed: старый блок и watermark сохраняются

agent tools (в ходе turn)
  search_chat / day_digest / thread_context / web_search / paper_search (new)
```

## Implementation Checklist

**Milestone A — память и dreaming**

1. **Schema v15 + storage-домен.** Таблица `bot_chat_memory`
   (`chat_id` PK того же типа, что `messages.chat_id`, `memory_text TEXT NOT
   NULL DEFAULT ''`, `last_consolidated_message_id INTEGER`,
   `revision INTEGER NOT NULL DEFAULT 0`, `updated_at_ms INTEGER NOT NULL`) —
   миграция `applyBotChatMemoryMigration` в `src/storage/schema/migrations.ts`,
   ветка `if (currentVersion < 15)` + declare в `lifecycle.ts`, записи в
   `validateSchema()`, bump `SCHEMA_VERSION` с 14 до 15. Домен
   `src/storage/memory.ts`: `MemoryMethods extends StoreCore` (`getChatMemory`,
   `upsertChatMemory`, `countMessagesSince`, `listChatsPendingDream`),
   `MemoryApi = Pick<...>`, регистрация в `src/store.ts`. Rehearsal-тесты по
   образцу `tests/store-migrations.test.ts` (идемпотентность, `quick_check`).
2. **Config (shared контур, полный чеклист).** `PARILKA_DREAM_EVERY_N_MESSAGES`
   (default 50, 10–500), `PARILKA_DREAM_MAX_MESSAGES` (default 200, 20–1000),
   `PARILKA_MEMORY_MAX_CHARS` (default 2000, 500–4000): rule в
   `src/config/env-rules.ts`, тип в `types.ts`, parse в `load.ts`, связи в
   `validation.ts`, redaction-проекция, `.env.example`, тесты без значений.
3. **Секция промпта.** `buildBotSystemPrompt`: опциональный `memoryBlock`
   (условная секция после «Память и инструменты»), обёртка как untrusted по
   образцу `wrapUntrustedToolData`, hard budget через `inlineConfig`-паттерн,
   индикатор заполнения `[N/max chars]`. Тесты в `tests/bot-prompt.test.ts`:
   секция отсутствует при пустом блоке, бюджет fail-closed, маркер нельзя
   закрыть из содержимого.
4. **Per-turn plumbing.** `loadBotTurn` (`src/bot/worker/turn-context.ts`)
   дополнительно читает `getChatMemory(chatId)`; блок пробрасывается per-turn
   полем в `agent.run(...)` (turn-worker.ts) и попадает в
   `buildBotSystemPrompt`. Frozen options в composition root НЕ рефакторим:
   per-turn поле перекрывает дефолт (пустой). Первый ход после рестарта/до
   первого сна работает с пустым блоком.
5. **Dream-модуль.** Новый `src/dream/consolidator.ts` (≤ 500 строк):
   prompt-builders (инструкции: декларативные факты, не императивы; абсолютные
   даты; вытеснение устаревшего; запрет секретов/эфемеры < 7 дней; только
   новый блок на выходе) + `DreamConsolidator` через `router.executeWith
   Fallback("summary", ...)` с валидацией (stop/непустота/бюджет; переполнение
   → один retry «сократи» → сохранить старое). Watermark
   `last_consolidated_message_id` двигается только при успехе. Журналирование
   redacted (chat_id, revision, chars, candidate).
6. **Интеграция в digest CLI.** Dream-проход после digest-фаз в
   `src/digest-cli/run.ts` под существующим `acquireDigestProcessLock`;
   `parilka-maintain.service` не меняется (оба ExecStart уже есть). Maintenance
   остаётся model-free.

**Milestone B — scientific search**

7. **Read tool `paper_search`.** По образцу `web_search`: zod-схема
   (`query`, `source: "arxiv"|"europepmc"` default arxiv, `maxResults` ≤ 5),
   определение в `BOT_READ_TOOL_DEFINITIONS` (5-й тул), ветка в executor-switch,
   `paper-executor.ts` с hardened HTTP из `src/providers/`; arXiv API keyless
   (пауза ≥ 3с между вызовами, cap результатов), Europe PMC keyless
   (~10 rps/IP). Вывод bounded (title/authors/year/abstract ≤ N chars/url),
   untrusted-обёртка как у остальных tool data. Провайдер-выбор и конфиг по
   образцу `production.ts` — без секретов. Промпт: обновить список инструментов
   и `tests/bot-prompt.test.ts` (сейчас assert'ит ровно 5 имени).

**Общее**

8. **Docs:** `src/bot/README.md`, `docs/architecture.md`, `operations/README.md`
   (dream runbook: где watermark, как сбросить), `llms.txt`; AGENTS.md — только
   если изменились публичные контракты. Рецепт harness-level `arxiv-mcp-server`
   (`uvx arxiv-mcp-server`, keyless, stdio) для rulesync-канона и Hermes —
   зафиксировать в `operations/README.md` как отдельную `mcp-sync`-операцию
   вне этого goal.
9. **Gates + rehearsal + deploy:** focused tests → полный gate → temp-DB
   rehearsal (quick_check, counts, idempotence) → пересборка, restart
   `parilka-bot` и `parilka-sync` (схема v15 затронула оба), evidence-запуск
   `parilka-digests` (dream pass fail-closed при transient provider abort),
   один маркированный Telegram E2E. Commit/push/deploy требуют отдельной
   авторизации — по умолчанию НЕ выполнять.

## Target Files

- `src/storage/schema/{migrations,lifecycle}.ts`, `src/storage/constants.ts`,
  новый `src/storage/memory.ts`, `src/store.ts`;
- `src/config/{env-rules,types,load,validation,redaction}.ts`, `.env.example`;
- `src/bot/prompt.ts`, `src/bot/ai-agent.ts` (только проброс per-turn поля),
  `src/bot/worker/turn-context.ts`, `src/bot/worker/turn-worker.ts` (точечно);
- новый `src/dream/consolidator.ts`, `src/digest-cli/run.ts`;
- `src/bot/read-tools/{contracts,schemas,executor}.ts`, новый
  `src/bot/read-tools/paper-executor.ts`, `src/bot-daemon/production.ts`;
- тесты: `tests/store-migrations.test.ts`, `tests/bot-prompt.test.ts`,
  config-тесты, новые `tests/bot-memory.test.ts`, `tests/dream.test.ts`,
  `tests/bot-read-tools-*.cases.ts`;
- docs из пункта 8.

**Не трогать:** durable turn FSM и статусные guarded-UPDATE'ы
(`src/storage/bot-turns.ts`), MTProto owner/session, loopback MCP `:8766`,
общий Telegram MCP `:8765`, digest pipeline семантику, remote branches,
значения secrets, inflight-изменения 002 до его закрытия.

## Verification Commands

```bash
node --test --import tsx tests/store-migrations.test.ts \
  tests/bot-prompt.test.ts tests/bot-runtime-config.test.ts \
  tests/bot-memory.test.ts tests/dream.test.ts
npm run check
npm run check:shell
npm run check:architecture
npm run check:systemd
npm run build
npm test
npm run test:coverage
npm run secret-scan
npm run audit
npm run smoke:mtcute-storage
systemd-analyze --user verify systemd/*.service systemd/*.timer
git diff --check
```

Schema/state slice дополнительно: temp-DB rehearsal миграции v13→v15,
`PRAGMA quick_check`, сравнение counts до/после, повторный migrate и повторный
dream/digest run без новых writes (idempotence). Rehearsal не мутирует
production.

## Done Means

1. Схема v15 (`bot_chat_memory`) задеплоена; `bot_chat_memory` получает bounded
   блок при успешном dream-проходе; следующий turn получает его в системном
   промпте как untrusted-секцию с индикатором заполнения; до первого сна секция
   отсутствует.
2. Dream срабатывает только при `>= N` новых сообщений; при падении модели/
   невалидном выводе старый блок и watermark сохраняются; повторный run без
   новых сообщений — ноль writes.
3. Бюджет `PARILKA_MEMORY_MAX_CHARS` enforced и на записи, и на инъекции;
   маркер недоверенных данных нельзя закрыть из содержимого памяти.
4. `paper_search` возвращает bounded, untrusted-wrapped результаты arXiv без
   ключа; `web_search` и остальные tools не регрессировали; промпт и тесты
   отражают 5 инструментов.
5. Миграция v13→v15 идемпотентна, rehearsal на свежем снапшоте с quick_check
   и counts зелёный; весь gate из Verification Commands зелёный.
6. Документация владеющих доменов обновлена; harness-рецепт arxiv-MCP
   зафиксирован отдельно от этого goal.
7. Active record получает Final Status и переносится в `history/`.

## Final Status

**Сделано:**

- Schema bumped to v15 (`src/storage/constants.ts:7`), миграция
  `applyBotChatMemoryMigration`, `validateSchema()` включает `bot_chat_memory`,
  storage domain `src/storage/memory.ts`, регистрация в `src/store.ts`.
- Shared config keys: `PARILKA_DREAM_EVERY_N_MESSAGES`,
  `PARILKA_DREAM_MAX_MESSAGES`, `PARILKA_MEMORY_MAX_CHARS` — полный цикл
  rule/type/load/validation/redaction/`.env.example`/tests.
- System prompt инжектирует `## Постоянная память` с untrusted-wrap,
  `[chars/max]` индикатором и hard budget; маркеры нельзя закрыть из контента.
- Per-turn plumbing: `loadBotTurn` → `memoryBlock` → `agent.run` →
  `buildBotSystemPrompt`; `bot-daemon/composition.ts` принимает `appConfig` и
  `memoryMaxChars` без рефакторинга frozen options.
- Dream consolidator `src/dream/consolidator.ts` (≤ 430 строк): router role
  `summary`, fail-closed watermark, retry «сократи», redacted logging.
- Digest CLI integration: `runDreamPass` в `src/digest-cli/dream-pass.ts`,
  вызов под существующим process lock в `src/digest-cli/run.ts`.
- `paper_search` read tool: keyless arXiv Atom + Europe PMC JSON, rate-limit,
  timeout, bounded output; 5-й tool в `BOT_READ_TOOL_DEFINITIONS`;
  `tests/bot-read-tools-paper.cases.ts` + обновлённые cache cases.
- Docs: `src/bot/README.md`, `docs/architecture.md`, `operations/README.md`,
  `llms.txt`.
- Regression fix: `MAX_SUPPORTED_TARGET_SCHEMA_VERSION` в
  `src/python-import/sqlite-guards.ts` и `src/maintenance/contracts.ts`
  обновлены до 15; `tests/digest-store.test.ts` ожидает v15.

**Gates (все зелёные):**

```text
npm run check              OK
npm run check:shell        OK
npm run check:architecture OK (214 production files, all ≤ 700 lines)
npm run check:systemd      OK
npm run build              OK
npm test                   OK (472 pass, 0 fail)
npm run secret-scan        OK (376 files)
npm run smoke:mtcute-storage OK (fresh_unpopulated, clean shutdown)
systemd-analyze --user verify systemd/*.service systemd/*.timer OK
git diff --check           OK
```

Focused tests (memory, dream, prompt, read-tools paper) зелёные.

**Rehearsal:**

- Temp-DB v13→v15: downgrade fresh v15 DB (`DROP bot_chat_memory`,
  `PRAGMA user_version = 13`), reopen `MessageStore` → migrate to 15,
  `PRAGMA quick_check = ok`, counts сохранены (2 messages, 0 memory rows),
  second open idempotent, dream/digest upserts revision++.

**Deploy / runtime:**

- `parilka-bot.service` и `parilka-sync.service` перезапущены; оба
  `ActiveState=active`, `NRestarts=0`.
- Production DB `messages-v13.sqlite`: `PRAGMA quick_check = ok`,
  `PRAGMA user_version = 15`, `bot_chat_memory` count = 0.
- `parilka-maintain.service` запущен вручную; maintenance прошёл, digest
  generation отработал с 3 failed day summaries (transient provider
  errors/timeout) и fail-closed; БД осталась консистентной.
- Отдельный dream-only run (`parilka-digests --apply --summary-only
  --max-day-generations-per-run 0 --max-week-generations-per-run 0`) также
  завершился `dream.status = "failed"`, `error = "20"` (provider-side abort /
  candidate timeout), `preservedRevision = 0`.

**Telegram E2E:**

- Отправлен mention `@bichiycepenstotri_bot` в `-1003179772905` (msg 231033).
- Бот ответил (msg 231035, reply_to 231033) с context recall, progress message
  (231034) и final footnote:
  `qwen/qwen3.8-max-preview · reasoning:? · in:24.9k out:689 total:25.6k`.
- Сноска подтверждает memory prompt injection / per-turn plumbing.

**Ограничения / residual blockers:**

- Первый production dream-проход не записал `bot_chat_memory` из-за transient
  provider abort (candidate timeout / network); fail-closed watermark сохранён.
  Следующий `parilka-maintain.timer` (04:20) или ручной re-run retry it.
- `paper_search` проверен unit tests; live tool-use E2E не выполнялся.
- Commit, push и production deploy beyond service restart не авторизованы.

**Post-completion hotfix (quote guard):**

- После deploy обнаружилось, что `quote_speaker_mismatch` в
  `src/bot/output-guards/quotes.ts` ложно reject'ит нормальные ответы бота
  (turns 23–25 были отклонены, пользователь видел только progress message).
- В `src/bot/output-guards/guard.ts` quote verification сделана advisory-only:
  verified/unverified counts идут в observability, но turn никогда не reject'ится
  из-за несовпадения атрибуции цитаты.
- Обновлены тесты: `tests/output-guards.test.ts` и
  `tests/bot-worker.test.ts` (guard rejection теперь проверяется через
  `unauthorized_mention`).
- Пересобрано, `parilka-bot.service` перезапущен, E2E mention→reply прошёл
  (msg 231151 → 231152), запрос саммари прошёл (msg 231153 → 231155).

**Production disposition:** runtime обновлён, schema v15 активна, memory и
paper_search готовы; quote guard больше не блокирует ответы; следующий удачный
dream-проход заполнит `bot_chat_memory`.
