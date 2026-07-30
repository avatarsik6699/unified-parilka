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
