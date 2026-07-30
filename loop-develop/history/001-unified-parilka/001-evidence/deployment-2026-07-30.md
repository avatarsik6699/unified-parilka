# Production deployment and Telegram E2E — 2026-07-30

Статус: controlled cutover завершён. Unified services active/enabled,
legacy Parilka services disabled/inactive, canonical Parilka MCP переключён
на unified stdio proxy. Общий машинный Telegram MCP не изменён.

## Final state handoff

После остановки legacy writers создан не rehearsal, а новый final target:

- legacy MCP source: 224 630 сообщений;
- Python source: 2 029 `live_msg`;
- первый apply: 6 inserts, 2 023 overlaps, 294 missing-text fills,
  0 conflicts;
- второй apply: 0 inserts/fills/conflicts и 0 writes;
- production target после import: 224 636 сообщений, schema v13,
  `quick_check=ok`;
- authoritative sender/name/text/reply mismatches: 0;
- human date conflicts: 0;
- 145 documented own-message `local_send_observation` dates не заменили
  canonical MTProto dates;
- maintenance применил 7 stale running и 6 845 terminal history jobs;
  второй dry-run нашёл 0 candidates;
- digest dry-run спланировал 267 завершённых дней, пропустил текущий день и
  сделал 0 provider calls.

Legacy Python outbox (`drafted=12`, `failed=4`, `sent=158`, `skipped=2`)
не импортирован и не replayed. Перед handoff active/ambiguous new outbox и
незавершённые `turn.start` отсутствовали.

Canonical production paths:

- application DB:
  `/home/billy/.telegram-parilka-mcp/messages-v13.sqlite`, mode `0600`;
- mtcute auth DB:
  `/home/billy/.telegram-parilka-mcp/mtcute-auth.sqlite`, mode `0600`;
- private runtime env:
  `/home/billy/.config/parilka/parilka.env`, mode `0600`.

## Runtime cutover

Active/enabled:

- `parilka-sync.service`;
- `parilka-bot.service`;
- `parilka-maintain.timer`.

Disabled/inactive:

- `telegram-parilka-sync.service`;
- `parlang-bot.service`;
- `parlang-watchdog.service`;
- `parlang-maintain.timer`.

`parilka-sync` является единственным Parilka MTProto owner и слушает
`127.0.0.1:8766`. Отдельный `telegram-mcp.service` остался active/enabled на
`127.0.0.1:8765`; его service/main process не перезапускался. MCP send flags
остались `false`/hard dry-run, embeddings выключены.

В оба канонических rulesync source добавлен только target
`telegram-parilka` с command
`/home/billy/repos/parilka-unified/bin/telegram-parilka-mcp`. Точная
последовательность `mcp-sync --dry-run`, `mcp-sync`, `mcp-sync --check`
завершилась успешно. Общий target `telegram` не менялся.

## One authorized live E2E

Через подключённый Telegram account отправлен ровно один маркированный mention
в разрешённую группу:

- trigger message ID: `230592`;
- Bot API update ID: `636426173`;
- bot reply message ID: `230593`;
- reply target: `230592`.

Проверенная цепочка journal:

1. `bot.update.committed`;
2. `bot.agent.complete`, DeepSeek candidate attempt 1, без fallback/tools;
3. `bot.turn.sent`.

В SQLite `bot_turns.id=1` имеет status `sent`, attempt 1 и
`telegram_message_id=230593`; parent `bot_updates` тоже terminal `sent`.
Оба сообщения сохранены, reply metadata совпадает, unsafe nonterminal rows
после E2E равны нулю. Содержимое сообщения/model output в evidence не
дублируется. Повторный live send для проверки не нужен.

## Startup and shutdown findings

Во время первого production startup закрыты три environment-specific
дефекта:

1. Node.js ABI 147 потребовал native rebuild `better-sqlite3`; package policy
   теперь явно разрешает install script pinned dependency, а
   `smoke:mtcute-storage` проверяет реальную fresh SQLite migration.
2. Legacy session оказалась compact Telethon StringSession, хотя GramJS её
   принимал. Import теперь пробует GramJS conversion, затем строгий Telethon
   fallback и валидирует 256-byte auth key.
3. mtcute 0.31 регистрировал синхронный `SIGTERM` cleanup раньше daemon
   runner и оставлял completed RPC timeout handles после успешного destroy.
   Owner-managed platform оставляет сигналы приложению, shutdown по стадиям
   закрывает embeddings/MCP/Telegram/storage, а process завершается только
   после `sync.shutdown_completed` и flush логов.

После исправления два диагностических `systemctl restart` заняли 91 ms и
114 ms. Первый post-build rollout занял 88 ms для sync и 156 ms для bot;
sync закрыл owned stages за 21 ms, а bot подтвердил offset перед чистым
restart. После финальной MCP description/operator-skill правки sync
перезапущен ещё раз за 106 ms: загруженная сборка записала
`sync.shutdown_completed` с `status="ok"` и закрыла все owned stages за
32 ms, без `telegram.destroy_failed`/SQLite errors. Первый tick нового PID
сохранил доступную строку и корректно перешёл в bounded retry после
`FLOOD_WAIT_14`; последующий recovery tick проверен отдельно в финальном
runtime sign-off. Серия более ранних диагностических рестартов один раз
исчерпала штатный `StartLimitBurst`; счётчик был явно сброшен, после чего
service вернулся в healthy state.

## Rollback readiness

Private bundle:
`/home/billy/.telegram-parilka-mcp/rollback/20260730T171354Z`, directory mode
`0700`; files mode `0600`.

- `legacy-mcp.sqlite` SHA-256:
  `8bb0541128cb6cd7659d4726c09fc23327a63ba371b4c52c504cbd40c15e5b65`;
- `legacy-bot.sqlite` SHA-256:
  `39d8fb5dad7c7a434ac221f40ce6f3a129c876368d2e7681b3c50c873abd70dd`;
- old unit copies and private cutover audit сохранены рядом.

Rollback не выполнялся: после live Telegram send он требует сверки внешней
доставки и явной disposition новых terminal/ambiguous rows. Каноническая
процедура находится в `operations/MIGRATION.md`.

## Production timer validation

Manual start того же `parilka-maintain.service`, который вызывает timer,
проверил реальный systemd sandbox/env/provider path. Первый запуск выявил, что
`ProtectSystem=strict` не разрешал digest SQLite lock писать в общий `%t`;
maintenance при этом завершился clean, provider call не начался. Временное
решение с private `RuntimeDirectory` доказало sandbox path, но независимый
delta-review обнаружил split namespace между timer и обычным CLI. Финальная
реализация держит sidecar SQLite lock рядом с canonical application DB и
выводит его имя из device/inode. Поэтому systemd и ручной CLI конкурируют за
один OS-backed lock независимо от `XDG_RUNTIME_DIR`; cross-context regression,
focused test и `systemd-analyze --user verify` защищают этот контракт.
Scheduled digest использует `--summary-only`: успешный run пишет один bounded
JSON summary вместо прежнего pretty-report на 2 767 journal lines.

Apply-zero под тем же sandbox доказал lock/open/write path и инвалидировал три
legacy digest rows без source. Первый bounded provider run с прежним лимитом
сгенерировал три day summaries, но честно отметил восемь high-volume days
`input_too_large`. Максимальный фактически отрендеренный historical day равен
627 458 characters; production bound поднят до 800 000, ниже официального 1M
context DeepSeek V4; источник и выбор описаны в
[provider decision](provider-deployment-decision.md). Следующий run записал
ещё две summaries и получил один transient `candidates_exhausted`; один
bounded retry завершился успешно:

- maintenance integrity `ok`, candidates/changes 0, WAL remaining frames 0;
- digest provider calls 3, generated 3, failed 0;
- текущий Moscow day пропущен;
- оставшиеся 256 candidates сохранены как `deferred/run_limit`;
- service `Result=success`, timer остался active/waiting.

Итого во время production timer validation записано восемь новых day
summaries; Telegram sends не выполнялись. Backlog намеренно разбирается по три
day и одной week generation за scheduled run.

Финальный post-lock rollout повторно запустил точный установленный unit.
Первый compact run записал 3/3 day summaries, но weekly fallback вернул
transient `candidates_exhausted`; service честно завершился с exit 1, не
повредив week state. Один bounded retry завершился `Result=success`:

- days: calls 3, generated 3, failed 0;
- weeks: calls 1, generated 1, failed 0;
- remaining deferred backlog: 250 day и 38 week candidates;
- invocation journal: 47 строк, digest report занимает одну строку;
- production DB: schema v13, `quick_check=ok`, active/lost-ack turns и
  queued/sending outbox — 0;
- state directory mode `0700`, lock sidecar mode `0600`.

Отдельная production-inode probe удерживала lock в обычном окружении: процесс
с другим `XDG_RUNTIME_DIR` получил `digest_lock_held`, а после завершения
владельца lock был успешно взят снова. Дополнительный fail-closed guard требует
`nlink=1` до read-only preflight и повторно перед apply lock, поэтому hardlink
alias без shared env не может разделить WAL/lock namespace. Timer остался
enabled/active; Telegram sends ни один maintenance/digest run не выполнял.

## Scope discipline

- commit/push не выполнялись и не были авторизованы;
- remote branches не менялись;
- общий Telegram MCP и соседние services не заменялись;
- временные rehearsal/diagnostic directories удалены после финальных gates;
- открытые P0/P1 после post-cutover review: 0.
