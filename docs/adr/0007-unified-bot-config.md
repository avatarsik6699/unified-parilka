# ADR 0007: one `BOT_BOTS_CONFIG_PATH` file for both bot roles

- Статус решения: принято
- Дата решения: 2026-08-23

## Контекст

Фаза 4 (продуктовое видение) требует декларативного создания/настройки
ботов, в перспективе через TUI. До этого решения роли конфигурировались
двумя несовместимыми способами:

- роль «помощник» (ADR/Фаза 7): `BOT_MULTI_CHAT_CONFIG_PATH` — JSON-массив
  `{chatId, chatTitle, personaPromptPath, approximateMemberCount?}`,
  читаемый только `bot-agi-bot`;
- роль «человек» (ADR 0005): россыпь из ~9 отдельных скаляров
  `BOT_HUMAN_PERSONA_*`, читаемых напрямую из `process.env` двумя разными
  процессами (`bot-agi-sync` — trigger/send, `bot-agi-bot` — отдельно
  `BOT_HUMAN_PERSONA_APPROVAL_CHAT_ID` для approval-поста).

Два формата в одном приложении — прямое препятствие для будущего
декларативного UI/TUI (пришлось бы знать оба формата и их раздельные
инвариванты), и уже сегодня создаёт риск рассинхронизации: approval chat id
читался в `bot-agi-bot` независимо от чата/персоны, которую описывает
`bot-agi-sync`, без единого источника истины.

## Решение

Один файл, одна схема, обе роли: `BOT_BOTS_CONFIG_PATH` — JSON-массив
разнородных записей `{role: "assistant" | "human-persona", ...}`
(`src/bot-config/schema.ts`, zod discriminated union по `role`, `.strict()`
на каждый вариант). `BOT_MULTI_CHAT_CONFIG_PATH` и все `BOT_HUMAN_PERSONA_*`
scalars (кроме офлайн-CLI, см. ниже) удалены без обратной совместимости —
тот же принцип «чистый лист», что и в Фазах 6/7.

Новый модуль `src/bot-config/` (не `bot-daemon/`, не
`human-persona-trigger/`, так как файл общий для обоих процессов):

- `load.ts` — `loadBotDefinitionsFromEnv` читает и валидирует файл как
  массив разнородных записей, без role-specific пост-обработки.
- `assistant.ts` — `selectAssistantChats` фильтрует `role: "assistant"`,
  требует 1–`MAX_ASSISTANT_CHATS` (=5) уникальных `chatId`, резолвит
  `personaPromptPath` в текст персоны (перенесено из бывшего
  `bot-daemon/multi-chat-config.ts` без изменения поведения).
- `human-persona.ts` — `selectHumanPersona` фильтрует `role:
  "human-persona"`, допускает 0 или ровно 1 запись (больше одной — явная
  ошибка конфигурации, не тихий выбор первой; несколько персон роли
  «человек» одновременно — намеренно не поддержано в этой фазе, см.
  «Следствия»). Дефолты/диапазоны heuristics-полей (`activeHourStart`,
  `minSilenceMs` и т.д.), раньше проверяемые вручную в `intEnv`, перенесены
  на уровень zod-схемы (`.min()/.max()/.optional()`).

`bot-agi-bot` (`bot-daemon/production.ts`) вызывает
`loadBotDefinitionsFromEnv` + `selectAssistantChats` + `selectHumanPersona`
(последний — только чтобы прочитать `approvalChatId`/`personaId` для
approval-поста и disjointness-проверки). `bot-agi-sync`
(`sync/daemon-runner.ts`) вызывает `loadBotDefinitionsFromEnv` +
`selectHumanPersona` для trigger/send-раннеров. Оба процесса читают один и
тот же файл независимо, без нового IPC/event bus — согласуется с
анти-event-bus контрактом `CLAUDE.md`.

`BOT_BOTS_CONFIG_PATH`, отсутствующий целиком, трактуется по-разному по
ролям: `bot-agi-bot` требует его всегда (ассистенту нужен хотя бы один
чат); `bot-agi-sync` трактует отсутствие переменной как «человеческая роль
не сконфигурирована» (graceful no-op, как раньше отсутствие
`BOT_HUMAN_PERSONA_*`), но если переменная задана, а файл битый — падает
громко, как и раньше для настоящей misconfiguration.

## Следствия

- Явно вне рамок: мульти-персона роли «человек» (несколько записей `role:
  "human-persona"` одновременно, каждая со своим trigger/send-тиком) —
  `selectHumanPersona` намеренно ограничивает файл 0..1 такими записями;
  `runHumanPersonaTriggerTick`/`runHumanPersonaSendTick` остаются
  однократными вызовами в `daemon-runner.ts`. Расширение до N персон —
  отдельная будущая работа (по аналогии с Фазой 7 для sync-стороны), не
  блокирует эту унификацию.
- `consent_basis` (офлайн style-profile pipeline, ADR 0005) остаётся
  флагом/env `bin/bot-agi-human-persona-style`, не переезжает в этот JSON:
  другой жизненный цикл (одноразовое операторское решение о согласии), не
  относится к тому, «какие боты запущены прямо сейчас».
  `BOT_HUMAN_PERSONA_ID/CHAT_ID/TARGET_USER/CONSENT_BASIS` в `.env.example`
  для этого CLI не переименованы и не удалены.
- TUI сам по себе не входит в эту фазу — это только новый файловый формат,
  на котором TUI можно будет построить позже (Фаза 4 п.1).
- Ни владение процессами, ни trigger-engine, ни approval-workflow (ADR
  0005) не меняются по существу — меняется только то, откуда эти процессы
  читают конфигурацию.

## Альтернативы

- **Оставить два формата** — отклонён: прямое препятствие для
  декларативного UI, требующего единой модели «бот» независимо от роли;
  также оставляет риск рассинхронизации approval chat id между процессами.
- **Отдельные файлы на роль** (`BOT_MULTI_CHAT_CONFIG_PATH` +
  `BOT_HUMAN_PERSONA_CONFIG_PATH`) — отклонён: не даёт единой модели
  «список ботов этого деплоя», к которой в итоге должен прийти TUI; два
  файла означают два места для проверки консистентности вместо одного.
- **Поддержать сразу N записей `human-persona`** — отклонён на этом шаге:
  `runHumanPersonaTriggerTick`/`send` рассчитаны на один вызов за тик,
  расширение до N персон — отдельный редизайн sync-стороны (аналог
  coordinator-per-chat из Фазы 7), overengineering для текущего масштаба
  (Фаза 4: «пользователь ведёт горстку личных ботов»).
