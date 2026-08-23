# Human-persona role: operator runbook

Роль «человек» (ADR 0005) не идентифицирует себя как бот и может сама
инициировать сообщения. Она **выключена по умолчанию** — весь этот раздел
описывает процедуру, но не авторизует включение сам по себе; включение,
переключение auto-режима и остановка при подозрении на бан требуют отдельной
операторской авторизации, как и любой live-send.

## Прежде чем включать

- **ToS/бан-риск принят осознанно.** Роль работает через ту же MTProto-сессию,
  которой уже владеет `bot-agi-sync` (`BOT_MTPROTO_EXCLUSIVE_OWNER=true`,
  `src/telegram/exclusive-owner.ts`) — то есть от лица обычного личного
  аккаунта, не Bot API. Автоматизация обычного аккаунта нарушает условия
  использования Telegram; реальный риск — блокировка номера/аккаунта. Это
  решение пользователя, не техническая деталь конфигурации.
- **Согласие на «оцифровку».** `bin/bot-agi-human-persona-style` отказывается
  запускаться без `--consent-basis`/`BOT_HUMAN_PERSONA_CONSENT_BASIS`
  (`confirmed_by_owner` или `self`), и это поле сохраняется в БД вместе с
  профилем как evidence принятого решения. Система не проверяет, было ли
  согласие получено на самом деле — ответственность на операторе.

## Компоненты и где что живёт

| Компонент | Процесс | Что делает |
| --- | --- | --- |
| Style-profile pipeline | `bin/bot-agi-human-persona-style` (отдельный CLI, не daemon) | Компилирует манеру речи + примеры сообщений целевого человека |
| Trigger-engine | `bot-agi-sync` | Решает, когда и что инициировать; пишет `pending`-предложение |
| Send-tick | `bot-agi-sync` | Отправляет auto-режим напрямую; отправляет approval-режим после решения человека; регенерирует по запросу |
| Approval poster | `bot-agi-bot` | Постит `pending`-предложения approval-режима в отдельный approval-чат с кнопками |
| Callback/edit handling | `bot-agi-bot` | Обрабатывает нажатия кнопок и reply-правки в approval-чате |

Ни одна из этих способностей не активируется частично: у каждой свой набор
обязательных `BOT_HUMAN_PERSONA_*` переменных (см. `.env.example`), и
отсутствие любой из них тихо оставляет соответствующий runner
неактивным — поведение процесса не меняется.

## Обязательные переменные (см. `.env.example` для полного списка с дефолтами)

- `BOT_HUMAN_PERSONA_ID`, `BOT_HUMAN_PERSONA_CHAT_ID`,
  `BOT_HUMAN_PERSONA_TARGET_USER` — общие для style-profile, trigger-engine
  и send-tick.
- `BOT_HUMAN_PERSONA_CONSENT_BASIS` — только для style-profile CLI
  (`--apply`), не читается daemon-процессами.
- `BOT_HUMAN_PERSONA_APPROVAL_CHAT_ID` — только для `bot-agi-bot` (approval
  poster + callback handling). Отдельный чат от `BOT_HUMAN_PERSONA_CHAT_ID`:
  подтверждения и правки текста происходят там, не в чате персоны.
- `BOT_HUMAN_PERSONA_AUTONOMY_MODE` — `approval` (default) или `auto`.
- `BOT_MODEL_CONFIG_PATH` — уже используется другими daemon-процессами;
  переиспользуется тем же путём для роли «человек» (нет отдельного
  `BOT_HUMAN_PERSONA_MODEL_CONFIG_PATH`).

## Первый запуск: approval-режим, не auto

Рекомендованный порядок (согласуется с продуктовым решением из ADR 0005 —
начинать supervised):

1. Собрать style-profile: `bin/bot-agi-human-persona-style --apply
   --persona-id <id> --chat <chat_id> --target-user <user_key>
   --consent-basis confirmed_by_owner` (или `self`, если персона строится по
   собственным сообщениям пользователя).
2. Установить `BOT_HUMAN_PERSONA_ID/CHAT_ID/TARGET_USER` и
   `BOT_HUMAN_PERSONA_APPROVAL_CHAT_ID`; **не** устанавливать
   `BOT_HUMAN_PERSONA_AUTONOMY_MODE` (дефолт — `approval`).
3. Перезапустить `bot-agi-sync` и `bot-agi-bot` (отдельная операторская
   авторизация на restart).
4. Наблюдать за approval-чатом: каждое предложение персоны приходит с
   кнопками Подтвердить/Отклонить/Перегенерировать/Скорректировать. Правка
   текста — обычный reply на запощенное сообщение, не отдельная команда.
5. Только после того, как качество предложений в approval-режиме
   устраивает, осознанно переключать `BOT_HUMAN_PERSONA_AUTONOMY_MODE=auto`
   и перезапускать `bot-agi-sync`.

## Диагностика без polling

Read-only SQL на snapshot (`PRAGMA query_only = ON`), тот же паттерн, что и
для основного бота:

```sql
-- Последние предложения персоны и их статус
SELECT id, status, autonomy_mode, created_at_ms, decided_at_ms
FROM human_persona_pending_proposal
ORDER BY created_at_ms DESC LIMIT 20;

-- Текущее состояние rate-limit/cooldown триггера
SELECT * FROM human_persona_trigger_state;

-- Есть ли уже собранный style-profile и на каком основании согласия
SELECT persona_id, target_user_key, consent_basis, source_hash, updated_at_ms
FROM human_persona_style_profile;
```

```bash
# Решения триггер-движка и попытки отправки (bot-agi-sync)
journalctl --user -u bot-agi-sync.service -o json | \
  jq '(.MESSAGE? | fromjson?) as $event |
      select($event.event | test("^human_persona_(trigger|send)\\.")) | $event'

# Постинг approval-запросов и обработка кнопок/правок (bot-agi-bot)
journalctl --user -u bot-agi-bot.service -o json | \
  jq '(.MESSAGE? | fromjson?) as $event |
      select($event.event | test("^human_persona\\.")) | $event'
```

## При подозрении на бан аккаунта или другую санкцию Telegram

1. Немедленно остановить `bot-agi-sync` (отдельная операторская
   авторизация) — это прекращает и sync-чтение, и любую активную отправку
   роли «человек», так как обе используют одну MTProto-сессию.
2. Не перезапускать `bot-agi-sync` с той же `TELEGRAM_SESSION`, пока
   статус аккаунта не подтверждён вручную (вход через официальный клиент
   Telegram с тем же номером).
3. `bot-agi-bot` можно оставить работающим — approval-чат и callback
   handling используют Bot API, отдельный аккаунт/токен, не затронуты
   баном личного аккаунта.
4. Незавершённые `human_persona_pending_proposal` в статусах
   `pending`/`claimed`/`approved`/`edited` останутся в БД до следующего
   успешного send-tick — они не теряются, но и не отправляются, пока
   `bot-agi-sync` не запущен заново на подтверждённо рабочей сессии.

## Отключение

Удалить (или закомментировать) `BOT_HUMAN_PERSONA_ID` (и/или
`BOT_HUMAN_PERSONA_APPROVAL_CHAT_ID` для `bot-agi-bot`) из env-файла и
перезапустить соответствующий процесс. Trigger/send/poster runner просто не
конструируются при следующем старте — это не отдельный kill switch, а то же
"опционально сконфигурировано" поведение, что и при первом включении.
