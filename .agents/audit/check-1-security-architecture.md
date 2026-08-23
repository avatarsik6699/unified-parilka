# Аудит безопасности — Архитектура (check-1)

Область: архитектурные security-границы `parilka-unified` (process topology,
network boundaries, secrets, storage, agent tool isolation, fail-closed defaults).
Метод: статический анализ кода и документации. Без live send / polling / model
calls (в соответствии с AGENTS.md).

> Снимок на дату аудита (до переименования `Parilka` → `bot-agi`,
> см. `operations/RENAME-BOT-AGI.md`) — упомянутые здесь `PARILKA_*`-имена
> с тех пор переименованы в `BOT_*`; находки ниже сохранены как есть, не
> актуализировались.

## Итоговая оценка

Архитектура демонстрирует зрелый, последовательный security-дизайн: явные
correctness/security boundaries, fail-closed defaults, DNS-pinned SSRF-защита,
hardened HTTP, структурированная redaction и строгая изоляция model-facing
tools от operator MCP writes. Критических архитектурных дефектов не выявлено.
Найдено несколько замечаний низкой/средней серьёзности и наблюдений.

## Подтверждённые сильные стороны (evidence)

1. **Fail-closed defaults** — `src/config/env-rules.ts:263-269`:
   `TELEGRAM_SEND_ENABLED=false`, `TELEGRAM_DRY_RUN_DEFAULT=true`,
   `TELEGRAM_LIVE_SEND_APPROVAL_BYPASS=false`, `TELEGRAM_EMBEDDINGS_ENABLED=false`.
   Live send выключен по умолчанию; bypass approval — тоже.

2. **Chat allowlist** — enforced на двух уровнях:
   - MTProto peer resolver (`src/telegram/mtcute/peer-resolver.ts:28-36`)
     бросает `Chat ... is not allowlisted` при `requireAllowlistedChat`.
   - Bot daemon сверяет `PARILKA_BOT_CHAT_ID` против
     `TELEGRAM_ALLOWED_CHAT_IDS` до открытия SQLite
     (`src/bot-daemon/production.ts:124-140`). Валидация длины/количества в
     `src/config/validation.ts:43-50` (≤100 chats, 1-256 символов).

3. **Loopback MCP transport** (`src/mcp-loopback.ts`) — привязка только к
   `127.0.0.1`, валидация endpoint URL (без credentials/query/fragment,
   bounded port 1024-65535), DNS-rebinding protection
   (`enableDnsRebindingProtection`, `allowedHosts`/`allowedOrigins`),
   origin-проверка, bounded sessions (default 32, hard cap 1024), idle sweep.
   MCP stdio proxy не владеет Telegram credentials/SQLite/session
   (architecture.md).

4. **Hardened provider HTTP** (`src/providers/model-router/hardened-fetch.ts`):
   `redirect: "error"` (credentials/prompt не replayed на redirect), bounded
   body 16 MiB через streaming reader + content-length precheck.
   `validateBaseUrl` (`config.ts:303-336`) запрещает credentials/query/fragment,
   требует HTTPS; HTTP только для loopback при явном `allowInsecureLocal`.

5. **SSRF-защита web_fetch** (`src/bot/read-tools/web-fetch-executor.ts`):
   только public HTTPS :443 без credentials; DNS резолвится ДО соединения,
   соединение идёт на pinned IP (`servername` для TLS); если ЛЮБОЙ из
   resolved-адресов приватный — отказ (защита от mixed-record rebinding);
   IPv4/IPv6 private ranges покрыты; redirects НЕ follow-ятся (возвращаются
   caller'у); 1 MiB bound; без cookies/JS/браузерного профиля.

6. **SQL injection отсутствует** — все 15 template-literal `prepare()`
   интерполируют только фиксированные column-name литералы или internally
   сгенерированные `?` placeholders; значения всегда через bound parameters
   (`toSqlValues`, `?`). Проверено: `embeddings.ts`, `send-outbox.ts`,
   `messages.ts`, `bot-turns.ts`, `bot-updates.ts`, `schema/objects.ts`.

7. **Redaction** — два слоя: `src/config/redaction.ts` (config inspection,
   `<set>/<missing>`, redact URL credentials/query) и
   `src/observability/redaction.ts` (logs: sensitive keys, embedded URLs,
   Bearer/sk-/ya29/JWT/Telegram-bot-token паттерны, depth/length bounds,
   circular guard). Message bodies/raw provider payloads в логи не пишутся.

8. **Agent tool isolation** — bot model никогда не получает operator MCP
   write/sync tools (architecture.md, `src/bot/agent/tool-set.ts`). Memory
   write tools появляются только при `memoryWriteAllowed`; gate
   (`src/bot/memory-policy.ts`) вычисляется из `request.trigger.text`
   (собственное сообщение адресованного пользователя), а НЕ из folded/search/
   memory/skill контента — untrusted text не может сам себя персистить
   (`src/bot/ai-agent.ts:213-215`).

9. **Single transaction kernel** — один `DatabaseSync`, WAL,
   `synchronous=FULL`, `BEGIN IMMEDIATE` вокруг атомарных transitions
   (architecture.md). Нет соединения-на-repository, нет вложенных транзакций.

## Замечания

### M1 (medium) — IPv6 transition mechanisms в SSRF-фильтре web_fetch
`isPublicAddress()` для IPv6 принимает любой адрес `/^[23]/` (global unicast
2000::/3), исключая только `2001:db8::/32` (documentation). Это пропускает
адреса механизмов перехода, инкапсулирующих произвольный IPv4:
- **6to4** `2002::/16` (например `2002:7f00:0001::1` инкапсулирует `127.0.0.1`);
- **Teredo** `2001::/32` (может нести приватный IPv4 в payload).

Эксплуатируемость зависит от наличия IPv6 и 6to4/Teredo-маршрутизации на хосте
(часто отключено в современных ОС), поэтому серьёзность medium, не high.
Рекомендация: явно исключить `2002::/16` и `2001::/32` (и при необходимости
`2001::/32` Teredo + `2002::/16`) в `isPublicAddress`, либо разрешать только
известные публичные диапазоны. Файл: `web-fetch-executor.ts`, функция
`isPublicAddress`.

### L1 (low) — Loopback MCP не имеет authentication token
`requestOriginAllowed()` возвращает `true` при отсутствии заголовка `Origin`
(легитимно для non-browser клиентов: curl, MCP harness). Поскольку сервер
привязан исключительно к `127.0.0.1`, любой локальный процесс/пользователь на
машине может подключиться и вызывать operator tools (включая write/sync).
Это задокументированный дизайн (loopback-only, single-host), но при shared-host
развёртывании это граница доверия. Рекомендация (опционально): рассмотреть
loopback shared-secret (env-only, redacted) для MCP, если хост многопользовательский.

### L2 (low) — Memory-write gate на regex пользовательского текста
`botMemoryWriteAllowedForText` — regex по `trigger.text`. Архитектурно gate
применяется только к собственному сообщению адресованного пользователя
(allowlisted chat), поэтому prompt-injection через web/search/forwarded content
не переключает gate напрямую. Остаточный риск: пользователь в allowlisted чате
пересылает/цитирует текст, содержащий триггерную фразу (например caption
forwarded message), что может включить write tools. Учитывая allowlist +
chat-scoped/bounded/source-attributed память, риск низкий. Рекомендация:
документировать, что `trigger.text` не должен включать quoted/forwarded bodies
в gate, либо применять gate к command-only префиксу.

### N1 (note) — HTML-текст web_fetch как untrusted input для модели
`extractPageText`/`htmlToText` делают базовую sanitization (вырезание
script/style/iframe и т.д.), но это не security-sanitizer для DOM — он лишь
готовит текст. Это корректно, т.к. результат трактуется как untrusted data
(`wrapUntrustedToolData`), а не исполняется. Подтверждает контракт
"tool output = недоверенные данные". Действий не требуется.

## Покрытые проверки (negative results — дефектов нет)

- SQL injection в storage layer — не найдено.
- SSRF через provider boundary — mitigated (redirect:error, URL validation).
- SSRF через web_fetch IPv4 — покрыто полностью (10/8, 127/8, CGNAT,
  link-local, RFC1918, benchmarking, documentation ranges).
- Утечка secrets в config inspection / logs — mitigated redaction.
- Escalation model→operator MCP writes — заблокировано tool isolation.
- Self-persisting prompt injection через memory — заблокировано gate-источником.
- Неограниченные network bodies — bounded (provider 16 MiB, web 1 MiB).

## Рекомендованный приоритет

1. M1 — ужесточить IPv6 SSRF-фильтр (6to4/Teredo). Низкое усилие, явный win.
2. L1/L2 — опциональные hardening-меры, зависят от модели развёртывания
   (single-user host vs shared). Текущий дизайн приемлем для single-host.
