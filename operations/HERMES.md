# Hermes Agent Profile для Парилка228

> Профиль и trusted plugin bridge для crowded Telegram-группы Парилка228
> (chat id `-1003179772905`). **Production cutover выполнен 7 августа 2026:**
> активен named gateway `hermes-gateway-parilka.service`, старый
> `parilka-bot.service` оставлен установленным, но остановлен и disabled для быстрого
> rollback. Default `hermes-gateway.service` не затронут и продолжает работу.

## Что это

Parilka-unified комплектуется готовым Hermes profile distribution для
Hermes ≥ 0.20.0:

- **`integrations/hermes/parilka-profile/`** — профиль Parilka228
  (`config.yaml`, `SOUL.md`, `distribution.yaml`, `.env.template`).
- **`integrations/hermes/parilka-profile/plugins/parilka_chat/`** — trusted
  plugin bridge к loopback MCP (`127.0.0.1:8766/mcp`).
- **`integrations/hermes/tool-schemas.json`** — checked-in артефакт схем пяти
  cache-only read tools (без `chat` и `source_message_id`).

Профиль спроектирован под установленный Hermes в `/home/billy/.hermes/hermes-agent`.

## Проверенные групповые семантики Hermes v0.20.0

| Механизм | Поведение |
|----------|-----------|
| Прямой @mention | Бот реагирует, даже без reply/regex |
| Reply-to-bot | Ответ на сообщение бота — trigger |
| `/command @bot` | Slash-команда с упоминанием бота — trigger |
| Ответ бота | Всегда в том же чате/topic, что и входящее сообщение |
| `group_sessions_per_user: false` | Одна общая сессия на группу (shared room brain) |
| `observe_unmentioned_group_messages: false` | Без @mention/reply входящие сообщения не читаются |
| Busy input mode: queue | Сообщения во время работы бота становятся в очередь, не теряются |
| `streaming.enabled: false` | Потоковая отправка выключена — ответы доставляются одним сообщением |
| `tool_loop_guardrails.hard_stop_enabled: false` | Мягкие предупреждения, без жёстких остановок |

**Важно:** native `observe_unmentioned_group_messages` отключён намеренно. В
чате с сотнями участников чтение всех сообщений без @mention создало бы
лавину лишних запросов. Вместо этого `pre_llm_call`-хук плагина вставляет
bounded закэшированный срез истории (через Parilka MCP/MTProto), давая боту
контекст без необходимости читать каждое сообщение через Bot API.

## Runtime footer и vision cap (parilka_chat)

- **Exact Telegram footer** — native `display.runtime_footer.enabled`
  остаётся `false` намеренно (native формат показывает %, не наш — включение
  дало бы дубль footer'а). Точный footer добавляет плагин (`runtime_hooks.py`,
  hooks `pre_llm_call`/`post_api_request`/`post_tool_call`/
  `transform_llm_output`):
  `<bare-model> 🧠 · <used>/<max> · <N> tool calls · <elapsed>`.
  Семантика: `used` = ТОЛЬКО `prompt_tokens` последнего API-вызова (уже
  включает cache ровно один раз; input/cache/output не суммируются, вызовы
  не накапливаются); `max` = 1048576 (компактно: `38.1k`, `1.0m`);
  `elapsed` — monotonic время хода (`30с`, `63` → `1м 3с`); `N` — число
  tool calls хода, включая blocked/error. Footer добавляется только для
  валидной Telegram-группы (`PARILKA_TELEGRAM_CHAT_ID` + session guard);
  состояние thread-safe, ограничено (TTL + max entries), без сырых данных.
- **Vision cap: 6 изображений на полный ход** — три связанных hook'а
  образуют сквозной ledger/bridge/gate для одного полного Telegram agent
  turn (только `platform=telegram`, exact chat id, `chat_type group`):
  - `pre_gateway_dispatch` (attachments cap): оставляет первые 6
    image-вложений одного merged Telegram MessageEvent; порядок
    сохраняется, non-image вложения не отбрасываются; при отбрасывании в
    текст добавляется системная пометка «взято N из M» без путей к
    файлам. Число оставленных изображений записывается в bounded ledger
    (`chat_id:message_id`) — metadata-only, без текстов/URL/путей.
  - `pre_llm_call` (budget bridge): атомарно переносит pending-счётчик
    оставленных вложений из ledger в бюджет текущего session+turn — ход
    без вложений начинает с нуля. Входящие attachments считаются в общий
    лимит.
  - `pre_tool_call` (gate): каждый разрешённый вызов `vision_analyze`
    атомарно учитывается (даже если инструмент позже упадёт); как только
    attachments + вызовы достигают 6, 7-й и последующие попытки
    блокируются стабильным коротким сообщением «Лимит анализа
    изображений: максимум 6 за один ход».
  - Вся state — thread-safe, bounded (TTL + max entries), metadata-only.
  Честное ограничение: загрузка вложений Telegram adapter'ом уже
  произошла к моменту хука — cap ограничивает только анализ.

## Native auth bootstrap

Перед первым запуском профиля необходимо заполнить секреты:

### Auxiliary vision (OpenAI Codex)

Аутентификация провайдера `openai-codex` — через native credentials Hermes,
без env-ключа в `.env`:

```bash
hermes -p parilka auth add openai-codex
```

### Provider (DeepSeek через Alibaba Token-Plan)

Профиль использует provider `qwen-token-plan` с транспортом `anthropic_messages`:

| Параметр | Значение |
|---------|----------|
| Provider name | `qwen-token-plan` |
| API endpoint (Anthropic) | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic` |
| Base URL (OpenAI-compat) | `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` |
| Transport | `anthropic_messages` |
| Auth env var | `ALIBABA_TOKEN_PLAN_API_KEY` |
| Default model | `deepseek-v4-flash-0731` |
| Models | `deepseek-v4-flash-0731`, `deepseek-v4-pro` |
| Context length | 1,048,576 |
| `discover_models` | `false` |

Ключ `ALIBABA_TOKEN_PLAN_API_KEY` получается в консоли token-plan и
записывается в `.env` установленного профиля. **Значение ключа не хранится
в репозитории.**

### Telegram Bot

Токен бота (`TELEGRAM_BOT_TOKEN`) получается через @BotFather и
записывается в тот же `.env` файл. Allowlist чатов уже зафиксирован в
`config.yaml` (`-1003179772905`). Memory write allowlist
(`PARILKA_BOT_MEMORY_WRITE_SENDER_IDS`) — CSV numeric Telegram user IDs —
заполняется оператором.

### Всегда-включённый session guard

Плагин fail-closed: разрешённая группа берётся **только** из обязательной
env-переменной `PARILKA_TELEGRAM_CHAT_ID` (в `.env.template` уже стоит
`-1003179772905`). Если переменная отсутствует или пуста — все handler'ы и
хуки не работают. Конфиг-allowlist в `telegram.allowed_chats` /
`group_allowed_chats` остаётся фиксированным в `config.yaml`.

### SearXNG + Firecrawl

Оба self-hosted на локальных URL:

- `SEARXNG_URL=http://127.0.0.1:8080` — SearXNG instance (именно `SEARXNG_URL`,
  а не `SEARXNG_BASE_URL`).
- `FIRECRAWL_API_URL=http://127.0.0.1:3002` — Self-hosted Firecrawl.
- Auxiliary vision (GPT-5.6 Luna) аутентифицируется через native credentials
  (`hermes -p parilka auth add openai-codex`), не через env-ключ.

В `config.yaml` заданы только `web.search_backend: searxng` и
`web.extract_backend: firecrawl`; топ-левел блоки `searxng:`/`firecrawl:`
отсутствуют — адреса берутся из env-переменных.

## Офлайн-валидация (без сети, без мутаций ~/.hermes)

```bash
# Python offline tests — запускать с PYTHONDONTWRITEBYTECODE=1
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'hermes_plugin_*.py' -v

# TS schema drift test
node --test --import tsx tests/hermes-tool-schemas.test.ts

# CLI, config kill-switch и systemd contract tests projection
node --test --import tsx tests/hermes-projection-cli.test.ts tests/config-hermes-projection.test.ts tests/hermes-projection-systemd.test.ts

# Статическая проверка units (Wants/After/ExecStart/ReadWritePaths)
systemd-analyze --user verify systemd/parilka-maintain.service systemd/parilka-hermes-project.service

# Полный test:hermes
npm run test:hermes

# TypeScript проверка
npm run check
```

## Install / re-bootstrap

Все команды требуют отдельной операторской авторизации и выполняются из
репозитория `parilka-unified`. Профиль устанавливается штатной командой
`hermes profile install` (никаких `cp`/`ln -s` в `~/.hermes` руками):

```bash
# 1. Установить профиль (включая плагин parilka-chat)
hermes profile install integrations/hermes/parilka-profile --name parilka -y

# 2. Сконфигурировать .env с реальными секретами
$EDITOR ~/.hermes/profiles/parilka/.env

# 3. Установить gateway для профиля (без запуска)
hermes -p parilka gateway install --no-start-now

# 4. Проверка профиля и его конфигурации (ничего не запускает)
hermes -p parilka doctor
hermes -p parilka config get model.default
hermes -p parilka config get model.provider
```

Дальнейшие команды профиля — только через `hermes -p parilka ...`
(никакой env-переменной `HERMES_PROFILE`).

## Bootstrap секретов

Профиль требует следующих секретов в `.env` установленного профиля:

| Переменная | Назначение | Где взять |
|-----------|-----------|----------|
| `ALIBABA_TOKEN_PLAN_API_KEY` | Primary model (DeepSeek v4 flash/pro) | Token-plan API console |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API | @BotFather |
| `TELEGRAM_HOME_CHANNEL` | Home target без first-run `/sethome` prompt | Фиксировано: `-1003179772905` |
| `SEARXNG_URL` | SearXNG instance URL | Self-hosted SearXNG |
| `FIRECRAWL_API_URL` | Firecrawl self-hosted URL | Self-hosted Firecrawl |
| `PARILKA_TELEGRAM_CHAT_ID` | Обязательная разрешённая группа | Фиксировано: `-1003179772905` |
| `PARILKA_MCP_HTTP_URL` | Loopback MCP URL | Default: `http://127.0.0.1:8766/mcp` |
| `PARILKA_BOT_MEMORY_WRITE_SENDER_IDS` | CSV numeric Telegram user IDs | Operator decision |

Auxiliary vision (`openai-codex/gpt-5.6-luna`) НЕ использует env-ключ:
bootstrap — `hermes -p parilka auth add openai-codex` (native credentials).

**Ни одно из этих значений не хранится в репозитории.** `.env.template`
содержит только placeholder'ы (пустые строки для ключей, локальные URL для
сервисов), но не секреты.

## Авторизация профиля

- **Primary model:** `qwen-token-plan/deepseek-v4-flash-0731` через provider
  `qwen-token-plan` с транспортом `anthropic_messages`, аутентификация через
  `ALIBABA_TOKEN_PLAN_API_KEY`. Endpoint:
  `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic`.
- **Auxiliary vision:** `openai-codex/gpt-5.6-luna` через provider
  `openai-codex`; bootstrap: `hermes -p parilka auth add openai-codex`
  (native credentials, не `.env`).
- **STT:** Flov Whisper на `http://127.0.0.1:17432/v1`, model `flov-whisper`,
  provider `openai`, language `ru`, `use_gateway: false` (на корне `stt`).

## Production cutover (выполнен 2026-08-07)

Текущий production — профильный Hermes unit `hermes-gateway-parilka.service`;
кастомный `parilka-bot.service` остановлен и disabled, но сохранён как rollback path.
Gateway Hermes управляется только native lifecycle
(`hermes -p parilka gateway ...`), никакого прямого `systemctl` для него:

```bash
# 0. Только на этапе cutover: уменьшить sync-lag MTProto-кэша до ~5 секунд
#    (systemd override parilka-sync.service или env)
TELEGRAM_SYNC_INTERVAL_MS=5000

# 1. Остановить кастомного бота (parilka-owned unit)
systemctl --user disable --now parilka-bot.service

# 2. Запустить Hermes gateway с профилем parilka (native lifecycle)
hermes -p parilka gateway start

# 3. Проверки после cutover: ответы в группе, кэш-контекст, write gate
```

## Rollback

Rollback останавливает Hermes gateway native-командой и возвращает старого
кастомного бота; никакого деструктивного удаления профиля:

```bash
# 1. Остановить Hermes gateway (native lifecycle)
hermes -p parilka gateway stop

# 2. Вернуть кастомного бота
systemctl --user enable --now parilka-bot.service

# 3. Удалить override и вернуть штатный fallback 60 секунд
TELEGRAM_SYNC_INTERVAL_MS=60000
```

## Hermes projection (parilka-hermes-project.service)

Отдельный `Type=oneshot` unit `parilka-hermes-project.service` применяет
commit'нутый Dream state (managed memory/skills) из общего SQLite в
установленный профиль `~/.hermes/profiles/parilka` (`bin/parilka-hermes-project
--apply`). Он намеренно НЕ является третьим `ExecStart` внутри
`parilka-maintain.service`: multi-ExecStart oneshot останавливается на первом
failed `ExecStart`, поэтому любой digest failure (например, частичный
`candidates_exhausted` после успешно commit'нутого Dream day) не дал бы
projection запуститься вообще.

Вместо этого `parilka-maintain.service` объявляет слабую зависимость
`Wants=parilka-hermes-project.service`, а projection unit имеет
`After=parilka-maintain.service`. При запуске maintenance systemd transaction
стартует wanted projection после того, как maintenance закончит activation,
**даже если maintenance failed**; `Wants` при этом не маскирует failed status
maintenance и не протаскивает failure projection обратно в maintenance.
Projection не имеет `Requires`/`BindsTo`/`PartOf` ни в одну сторону.

Kill switch — `PARILKA_HERMES_PROJECTION_ENABLED` (1/true/yes включает apply).
Его можно выставлять в `true` **только после** установки профиля (шаг 1
staging install) и `hermes -p parilka gateway install --no-start-now`;
missing/empty/false — projection завершается `skipped_disabled` ДО любых
DB/profile touches (unit успешно отрабатывает, ничего не трогая). Управлять
unit вручную не нужно: он стартует только как wanted от maintenance.
Наблюдение: `systemctl --user status parilka-hermes-project`,
`journalctl --user -u parilka-hermes-project -n 50`.

## Plugin bridge: контракт безопасности

Плагин `parilka-chat` действует как trusted bridge между Hermes и Parilka
loopback MCP:

1. **Session guard:** каждый handler и оба хука проверяют захваченный при
   регистрации `ctx.profile_name == "parilka"` и task-local session:
   - `HERMES_SESSION_PROFILE == "parilka"`
   - `HERMES_SESSION_PLATFORM == "telegram"`
   - `HERMES_SESSION_CHAT_TYPE == "group"`
   - `HERMES_SESSION_CHAT_ID == PARILKA_TELEGRAM_CHAT_ID` (обязательный env;
     отсутствие/пустое значение — fail closed)
   - `HERMES_SESSION_MESSAGE_ID` — положительное JS-safe целое
   `register()` регистрирует инструменты только при точном
   `profile_name == "parilka"` (не truthy-or-empty). Вне этой группы —
   fail-closed (no-op или отказ).

2. **source_message_id:** инжектится из `HERMES_SESSION_MESSAGE_ID`, никогда
   из model args. Model-facing схема не содержит этого поля — модель не может
   его подделать. Поле `chat` также исключено из схем. Любой ключ аргументов,
   отсутствующий в properties схемы (включая поддельные `chat`/
   `source_message_id`), отклоняется целиком: ошибка без dispatch, без
   молчаливого strip/forward.

3. **Raw MCP routing:** Hermes регистрирует MCP-инструменты под префиксным
   raw-именем `mcp__<sanitizedServer>__<tool>`
   (`tools/mcp_tool.py:mcp_prefixed_tool_name`; server key `telegram-parilka`
   → `telegram_parilka`). Плагин регистрирует в `parilka_chat` чистые имена,
   но `ctx.dispatch_tool` всегда вызывает **raw prefixed** имя:

   | Clean (model) | Raw (registry) |
   |---------------|----------------|
   | `rag_bm25_search` | `mcp__telegram_parilka__rag_bm25_search` |
   | `keyword_search` | `mcp__telegram_parilka__keyword_search` |
   | `read_chat_slice` | `mcp__telegram_parilka__read_chat_slice` |
   | `day_digest` | `mcp__telegram_parilka__day_digest` |
   | `thread_context` | `mcp__telegram_parilka__thread_context` |

   Вызов чистого имени зациклился бы на обёртке плагина. Raw MCP toolset
   отсутствует в `platform_toolsets` — модель видит только чистые
   инструменты.

4. **Outer shape:** успех — ровно `{"result": "<inner JSON>"}`; внутренний
   Parilka `{ok:false,...}` (typed operational error) проходит без изменений.
   Ошибки session/аргументов, внешние `{"error": ...}`, malformed/non-string
   outer, malformed inner — bounded generic top-level `{"error": "..."}`
   без сырых ValueError-деталей, ожидаемых ID и исключений. Логирование
   сырых исключений/значений отсутствует. Legacy MCP envelope
   (`content[0].text`) больше не поддерживается.

5. **pre_tool_call gate:** native `memory` и `skill_manage` — write-only
   инструменты. Все вызовы `"memory"` и `"skill_manage"` считаются записью
   (read-операции идут через `skills_list`/`skill_view` отдельно).
   - Захваченный `ctx.profile_name == "parilka"` и валидная task-local
     Telegram group session обязательны ДО любых origin-исключений.
   - `background_review` (проверяется через
     `tools.write_approval.current_origin()`) разрешён только при валидной
     Parilka group session.
   - Foreground: дополнительно требует `HERMES_SESSION_USER_ID` в CSV
     `PARILKA_BOT_MEMORY_WRITE_SENDER_IDS`.
   - `skill_manage` для managed projection targets (name `parilka-lessons`,
     prefix `parilka-skill-*`, category `parilka-managed`) блокируется всегда
     (stable generic error, без путей/секретов); projection пишет эти файлы
     напрямую.
   - `current_origin` из tool args никогда не доверяется.
   - Остальные инструменты проходят без изменений.

6. **write_approval:** профиль выставляет `memory.write_approval: false` и
   `skills.write_approval: false`, поэтому авторизованные writes действительно
   персистятся, а не остаются в staging-очереди.

7. **Context injection (`pre_llm_call`):** ровно один dispatch raw prefixed
   `read_chat_slice` с точными аргументами
   `{"mode":"recent","count":1000,"source_message_id":<current>}` — в схеме
   `read_chat_slice` нет `after_id`, поэтому фильтрация `id > prev_hw`
   выполняется локально. High-water маркер `\u200Bhw=N\u200B` пишется в
   КОНЕЦ инжектированного контекста и на следующем ходе парсится только из
   исторических `api_content` sidecars user-сообщений:
   - `api_content` обязан начинаться с точной чистой строки `content + "\n\n"`
     (композиция Hermes `compose_user_api_content`);
   - маркер обязан быть прижат к самому концу суффикса ПОСЛЕ
     `content + "\n\n"` (в самом `content`, в скопированном префиксе, в
     произвольном `api_content` или в середине суффикса игнорируется).
   Значение маркера — max id **реально отрисованных** валидных строк:
   пустые/malformed/не влезшие в бюджет строки его не двигают.
   Контекст:
   - Не более `MAX_CONTEXT_CHARS = 8500` символов включительно (заголовок,
     метаданные, маркер); никакого `+500` допуска.
   - Окно запроса — 1000 последних строк; строки `id >= source` и
     `id <= prev_hw` исключаются; выбираются новейшие подходящие строки,
     вывод хронологический; контекст никогда не режется внутри строки.
   - Строки — camelCase (`messageId`, `senderName`, `isOwnTurn`,
     `authorRole`, ...); `messageId`/`replyToMessageId` и границы окна —
     только положительные Python int (bool/float/oversize отклоняются),
     ≤ 9007199254740991; собственные ходы бота помечаются `[ассистент]`.
   - Длинный текст ограничивается с явным `[текст усечён]`.
   - Метаданные: границы окна (first/last), `totalAvailable`,
     `returnedCount`, `omittedCount`, `prev_hw`, число показанных строк,
     старшие строки, не влезшие в бюджет, и признак возможного разрыва до
     окна: `prev_hw < firstMessageId` (включая первую инъекцию) при
     `omittedCount > 0` или `hasMore`.
   - malformed `result`/`messages`/`coverage`, внутренний `ok:false`, пустой
     результат или нечего рендерить → `None` (fail soft, ход продолжается
     без контекста).

## MCP trust boundary

Loopback MCP Parilka (`127.0.0.1:8766/mcp`) защищён:
- DNS-rebinding protection, Origin/Host allowlist.
- Defensive admission limits: ≤32 sessions, ≤128 concurrent HTTP requests,
  ≤8 на сессию.
- `source_message_id` — application-owned поле, доступное только trusted
  bridge. Модель никогда не видит и не контролирует его.

Raw MCP tools (`rag_bm25_search`, `keyword_search`, `read_chat_slice`,
`day_digest`, `thread_context`) **не** экспонируются модели напрямую.
Вместо этого плагин регистрирует пять чистых инструментов в toolset
`parilka_chat` с теми же описаниями, но без полей `chat` и
`source_message_id`. Схемы синхронизированы с checked-in артефактом
`integrations/hermes/tool-schemas.json`.

## Инварианты

- Plugin fail-closed: вне группы из `PARILKA_TELEGRAM_CHAT_ID` или
  неправильного профиля каждый handler/hook — no-op или отказ.
- `source_message_id` никогда не берётся из model args; подделанные
  `chat`/`source_message_id` в аргументах отклоняются без dispatch.
- Success outer shape — только `{"result": "<inner JSON>"}`; protocol/outer
  ошибки — bounded generic top-level `{"error": "..."}`.
- MCP protocol errors поверхностно отделены от operational `ok: false`.
- High-water dedup через api_content sidecar (префикс `content + "\n\n"`,
  маркер в конце суффикса) предотвращает накопление повторяющегося
  контекста. Маркер в user content/середине суффикса игнорируется.
- Окно контекста — 1000 строк, бюджет ровно 8500 символов.
- Write gate: только allowlisted senders или background_review из валидной
  Parilka group session могут мутировать memory/skills. Managed projection
  targets (`parilka-lessons`, `parilka-skill-*`, category `parilka-managed`)
  никогда не редактируются моделью. current_origin из args не доверяется.
- `write_approval: false` означает, что авторизованные writes действительно
  персистятся, а не ставятся в staging.
- Никакие значения секретов не записаны в файлы репозитория.
- Plugin handler signature: `handler(args_dict, **kwargs)` — позиционный
  args mapping как в registry Hermes.
- dispatch идёт только через захваченный `ctx.dispatch_tool` с raw
  prefixed именами, без прямых импортов `tools.registry`.
- Один dispatch на вызов pre_llm_call.

## Проверка

```bash
# Python offline tests (без сети, без секретов, без ~/.hermes мутаций)
npm run test:hermes

# Или отдельно:
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'hermes_plugin_*.py' -v
node --test --import tsx tests/hermes-tool-schemas.test.ts

# Проверка TypeScript
npm run check

# Полный verify (включает build, smokes, provider-dependent тесты и secret scan)
npm run verify
```
