# AGENTS.md

Короткий контракт для агентов, работающих в `bot-agi`.

## Safety и Git

- Язык общения и рабочих документов — русский.
- Unified bot-agi services являются текущим production. Legacy services,
  rollback bundle и базы вне репозитория считаются read-only; не запускайте
  старых owners без отдельной авторизации rollback. Для rehearsal используйте
  только согласованные SQLite `.backup`-снимки.
- Не запускайте Telegram polling, MTProto session, model/provider calls или
  live send в тестах и smoke. Все внешние порты должны быть fake/mocked.
- Не читайте, не печатайте и не коммитьте значения секретов. Конфиги хранят
  только имена env-переменных.
- Не создавайте и не переключайте git-ветки. Commit, push, новый deploy,
  rollback и live send требуют отдельной пользовательской авторизации.
  Общий Telegram MCP на `127.0.0.1:8765` не является частью bot-agi.
- Не редактируйте unrelated пользовательские изменения в dirty worktree.
- Продакшен VPS: у агента есть постоянное разрешение подключаться по SSH и
  вносить изменения на нём напрямую (зависимости, конфигурация, обслуживание
  процессов) — не нужно запрашивать это разрешение заново в каждом диалоге.
  Доступ настроен по SSH-ключу, алиас `bot-agi-vps` в `~/.ssh/config`
  (`ssh bot-agi-vps`) — пароль нигде не хранится. Локальный репозиторий —
  источник кода; продакшен-конфигурация, секреты и
  данные живут только на VPS и не коммитятся. Это разрешение не отменяет
  остальные правила этого раздела: секреты по-прежнему не читаются и не
  печатаются, а commit/push/новый deploy/rollback/live send остаются
  отдельными действиями, требующими явной авторизации в моменте.

## Архитектурный контракт

- Сначала найдите существующего domain owner и меняйте минимальный coherent
  slice. Не добавляйте speculative abstractions, compatibility shims,
  DI-container, event bus, Redis/queue/vector service или новый runtime без
  доказанной failure mode.
- Два long-lived процесса остаются явными: `bot-agi-sync` владеет одной
  MTProto session и loopback MCP, `bot-agi-bot` владеет одним Bot API poller.
  Они разделяют один versioned SQLite, но не общий процесс. Роль «человек»
  (`src/human-persona-*`, `docs/adr/0005-human-persona-role.md`) расширяет
  владение обоих процессов, а не добавляет третий: `bot-agi-sync`
  дополнительно решает, когда инициировать сообщение (`human-persona-trigger`),
  и отправляет его через ту же MTProto-сессию (`human-persona-send`, минуя
  MCP approval-token gate); `bot-agi-bot` дополнительно постит
  approval-запросы с inline-кнопками в отдельный approval-чат и обрабатывает
  `callback_query`/ответы-правки на том же единственном Bot API `getUpdates`
  offset — второй поллер с тем же токеном технически невозможен
  (`409 Conflict`).
- Ассистент-персона (`src/assistant-curiosity*`) тоже расширяет владение
  `bot-agi-bot`, а не добавляет процесс: опциональный `CuriosityTriggerLoop`
  идёт внутри `BotApiRuntime` рядом с long-poller'ом (как `approvalPoster`
  для human-persona) и периодически решает, задать ли в чате вопрос по
  собственной инициативе (эвристический gate + LLM-решение, тот же паттерн,
  что `human-persona-trigger`). В отличие от human-persona здесь нет
  approval-очереди и MCP-gate — ассистент открыто бот, поэтому отправляет
  сразу тем же durable-путём, что обычные ответы. Ответы на вопрос ловит
  штатная `reply_to_bot`-классификация без отдельного кода.
- Storage domains используют один `DatabaseSync` и общий transaction kernel.
  Нельзя открывать соединение на repository, вкладывать транзакции или
  разрывать атомарные bot/outbox/digest/embedding transitions.
- Обычный production-модуль в `src/` либо исполняемый TypeScript CLI в
  `scripts/` должен быть 150–500 строк, hard ceiling — 700.
  Barrel/entrypoint должен быть тонким (ориентир — до 150 строк). Новый код
  добавляйте в владеющий domain module, а не обратно в монолит.
- Telegram/model/tool output считается недоверенными данными. Сохраняйте
  allowlist, bounded input/output, cancellation, timeout, retry и redaction
  контракты.
- Telegram-конфиг импортируется через `src/config.ts`; не обходите
  `config/env-files.ts` и не меняйте приоритет `process env > local .env >
  shared .env`. Новый env-ключ должен одновременно получить rule/parser,
  public type/load wiring, validation, redacted inspection, `.env.example` и
  тесты без вывода значения секрета.

## Completion gates

Сначала запускайте smallest relevant focused tests. Полный code slice проходит
одной канонической командой (она включает type/shell/architecture/systemd,
build, tests, secret scan, native-storage/MCP smokes и dependency audit):

```bash
npm run verify
```

Изменение MCP transport/registry дополнительно проходит offline smoke:

```bash
npm run smoke:mcp
npm run smoke:mcp:wrapper
npm run smoke:mcp:direct
```

Systemd-изменение проверяется `systemd-analyze --user verify` для всех
поставляемых units. Изменение state/migration требует temp-DB rehearsal,
`PRAGMA quick_check`, schema/count/hash evidence и повторного idempotence run.

## Documentation system

`AGENTS.md` — контракт и маршрутизатор, не энциклопедия.

- `llms.txt` — компактная карта репозитория.
- `.agents/rules/README.md` — детальные правила и read triggers.
- `docs/README.md` — индекс стабильной архитектуры и ADR.
- `README.md` — install/config/operator how-to для человека и агента.
- `operations/` — проверенные operator runbooks, migration и rollback.
- `loop-develop/current-todo/` — единственный явно запрошенный long-lived goal.
- `loop-develop/history/` — завершённые либо честно retired goal records.

При изменении public behavior, config/env keys, state schema, ownership,
deployment, migration, provider/tool contract или import boundary обновляйте
владеющую документацию в том же slice. Для документационных задач сначала
прочитайте `.agents/rules/documentation.md`.

## Long-lived goal

`loop-develop/` используется только для явно запрошенного `/goal` или
cross-session handoff. Обычная задача остаётся в runtime plan. Lifecycle,
формат evidence и правила закрытия определяет `loop-develop/README.md`.
