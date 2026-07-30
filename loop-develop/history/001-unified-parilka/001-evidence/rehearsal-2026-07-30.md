# Fresh SQLite rehearsal — 2026-07-30

Статус: пройдено на свежих согласованных `.backup`-снимках обоих live
SQLite sources. Legacy writers во время rehearsal не останавливались и
production state не изменялся.

## Source snapshots

- legacy MCP: `quick_check=ok`, schema v10, 224 618 messages,
  `id=1..14 820 696`;
- legacy Python bot: `quick_check=ok`, 2 017 `live_msg`, 266 day digests,
  40 weekly rollups;
- Python outbox только учтён: 12 drafted, 4 failed, 158 sent, 2 skipped;
- source message content hash:
  `c223a0af3241a1138e4b1b7aac28998dc16ad41f401e78fc5fd0e6621222b2e7`.

Snapshot file SHA-256:

- MCP: `7595103c14ea7b7e042b369f687e572496913cb531bf3f6372514c5a2dc6c91e`;
- Python bot:
  `c876186243a2541f431a6b12940ba9172f51075351387a27a45b1d66ff95f4f6`.

## Import and target verification

Новый shadow target создан SQLite backup-копией MCP snapshot, после чего
применён built Python importer:

- schema v10 → v13;
- messages 224 618 → 224 624, итоговый диапазон `id=1..14 822 972`;
- 266 day digests и 40 weekly rollups;
- `bot_updates=0`, `bot_turns=0`: legacy retry work не перенесён;
- все 2 017 source messages найдены в target, field mismatches = 0;
- target hash тех же 2 017 сообщений точно равен source hash;
- повторный apply сохранил message count/hash, day/rollup writes = 0.

## Maintenance

Первый dry-run нашёл 7 stale running и 6 845 terminal history jobs. Apply:

- перевёл/удалил ровно эти 7 + 6 845 rows по retention policy;
- не тронул bot turns/updates или terminal send outbox;
- passive WAL checkpoint: 304/304 frames, busy=0, remaining=0;
- повторный dry-run: все candidate counters = 0;
- финальный `quick_check=ok`, schema v13.

Legacy MCP `send_outbox` содержит 23 недавних `sent` audit rows; keep-last
policy намеренно их сохраняет.

## Digest plan

Built digest dry-run не вызывал provider:

- days scanned 268, candidates/planned 267, current day skipped 1;
- provider calls 0;
- weeks scanned 40, все blocked до обновления day digests;
- apply limits подтверждены конфигом: максимум 3 day + 1 week provider calls
  за запуск, newest-first; остальной backlog будет resumable/deferred и legacy
  rows не удаляются.

## Provider/config preflight

Production router использует официальный DeepSeek adapter,
`deepseek-v4-flash`, `thinkingMode=disabled`. Короткий реальный preflight
вернул точный `OK`, finish reason `stop`, candidate attempt 1 примерно за
0,9 секунды. Секреты и model text в evidence/log не записывались.

Private temporary rehearsal directory удаляется после final review; production
cutover создаёт новый snapshot уже после остановки legacy writers и не
продвигает этот shadow target.

## Post-review importer hardening recheck

После independent review сделан ещё один свежий `.backup`-rehearsal на
production-shaped данных. Review обнаружил 145 ожидаемых расхождений дат:
legacy `_record_own()` ставил исходящим bot messages локальное время после
`sendMessage`, тогда как MTProto target содержит каноническую Telegram date
(разница 1–41 секунда). Importer теперь учитывает provenance:

- для overlap с `live_msg.is_bot=1` непустая canonical target date сохраняется;
- отсутствующая target date всё ещё заполняется;
- date conflict у человеческого сообщения и конфликты sender/text/reply
  по-прежнему fail closed;
- malformed `is_bot` отклоняется.

Fresh source/target checks: `quick_check=ok`; MCP target 224 630 messages,
Python source 2 029. Первый apply дал 6 inserts, 2 023 overlaps, 294
missing-text fills, 0 conflicts и итог 224 636 messages. Второй apply:
0 inserts, 2 029 overlaps, 0 fills, 0 conflicts, 0 message/day/rollup writes.
Финальный target: `quick_check=ok`, schema v13. Production state не изменялся.
