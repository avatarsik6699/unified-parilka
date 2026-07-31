# Parilka Operations

Operator documentation находится вне архитектурного `docs/`.

## Start here

- [Migration and rollback](MIGRATION.md): consistent snapshots, shadow target,
  final target, cutover gates и rollback.
- [../README.md](../README.md): local build, config keys, CLI и systemd install.

## Safety summary

- Unified production services сейчас active; legacy Parilka services
  disabled/inactive и остаются только rollback path.
- SQLite state копируется через backup API/CLI, а не отдельным копированием
  main/WAL файлов при живом writer.
- Bot/sync owners не стартуют без exact acknowledgements
  `PARILKA_BOT_EXCLUSIVE_POLLER=true` и
  `PARILKA_MTPROTO_EXCLUSIVE_OWNER=true`.
- Bot находится в live mode; operator MCP writes отдельно остаются выключены
  и в hard dry-run.
- Не запускайте legacy owners или direct recovery рядом с unified services;
  это требует controlled rollback и проверки offset/outbox.
- Backup считается доказанным только после restore, `PRAGMA quick_check` и
  count/range/content-hash verification.

Runbook описывает процедуру, но сам по себе не авторизует новый stop/start,
send, rollback, commit, push или deploy.

## Bot memory and dreaming

- `bot_chat_memory` хранит один bounded Dream-блок на чат, watermark
  `last_consolidated_message_id` и `revision`. Он инжектируется в системный
  prompt как недоверенные данные (`## Постоянная память`) с индикатором
  заполнения.
- Schema v16 ввела строго chat-scoped explicit knowledge (оно сохраняется и в
  последующих schema versions):
  `bot_chat_fast_memory` (до 12 оперативных заметок, сразу в prompt),
  `bot_chat_lessons` (до 64 problem/solution/when-to-apply уроков) и
  `bot_chat_skills` (до 32 playbook). Последние два слоя дают только bounded
  index; модель загружает detail через отдельный tool по необходимости.
- Обычный ход может читать memory, но писать её может только адресный trigger,
  который прямо просит запомнить/сохранить/обновить заметку, урок или навык.
  Каждая запись source-attributed к ID этого сообщения, ограничена по размеру
  и отвергает вероятные credentials. Данные памяти не являются инструкциями
  для модели.
- Dream-консолидация запускается существующим `parilka-digests --apply`
  (`parilka-maintain.timer`, 04:20). Она срабатывает только когда с момента
  последнего watermark накопилось `>= PARILKA_DREAM_EVERY_N_MESSAGES`
  (default 50), но читает не больше `PARILKA_DREAM_MAX_MESSAGES` (default 200).
- При падении модели/невалидном выводе старый блок и watermark сохраняются
  (fail-closed), а digest CLI завершается ненулевым кодом. Dream использует те
  же `PARILKA_DIGEST_MODEL_TOTAL_TIMEOUT_MS` и
  `PARILKA_DIGEST_MODEL_CANDIDATE_TIMEOUT_MS`, что day/week summaries, но имеет
  отдельный компактный default 1024 output tokens (day/week budget не меняет) и
  одну bounded retry того же candidate после его timeout — без второго
  провайдера.
  Повторный прогон без новых сообщений не пишет в `bot_chat_memory`.
- Сбросить только Dream-блок можно через SQL:
  `DELETE FROM bot_chat_memory WHERE chat_id = '<chat_id>';`. Это сбросит
  watermark и бот начнёт с пустой Dream-памяти. Сброс всех explicit layers
  требует отдельно удалить rows того же `chat_id` из
  `bot_chat_fast_memory`, `bot_chat_lessons` и `bot_chat_skills`; делайте это
  только на подтверждённом backup/maintenance workflow, не во время live
  writer.
- Параметры:
  - `PARILKA_MEMORY_MAX_CHARS` — бюджет блока (500–4000, default 2000).
  - `PARILKA_DREAM_EVERY_N_MESSAGES` — порог консолидации (10–500, default 50).
  - `PARILKA_DREAM_MAX_MESSAGES` — сколько сообщений читать за проход
    (20–1000, default 200, должен быть >= порога).
