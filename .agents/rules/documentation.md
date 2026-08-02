# Documentation Rule

Используйте это правило, когда задача меняет документацию или может сделать её
устаревшей.

## Read order

1. `AGENTS.md`.
2. `llms.txt`, если нужна карта репозитория.
3. `docs/README.md` для маршрутизации стабильной архитектуры.
4. Конкретный ADR, domain README, active goal record или operator runbook,
   который владеет изменяемой областью.

Не загружайте все документы по умолчанию.

## Куда писать

- `AGENTS.md`: короткий durable agent contract и routing.
- `.agents/rules/`: reusable repo-specific поведение агентов.
- `llms.txt`: компактная навигация без дублирования всего docs index.
- `docs/`: только стабильная архитектура, контракты и принятые решения.
- `docs/adr/`: immutable rationale; статус реализации и evidence не выдавать
  за часть принятого решения.
- `src/<domain>/README.md`: локальная shape, public facade, invariants и
  focused verification домена.
- `operations/`: проверенные runbooks, systemd, backup, migration и rollback.
- `loop-develop/current-todo/`: явно запрошенный активный goal и его временное
  evidence.
- `loop-develop/history/`: verified completion либо честно
  retired/superseded record с Final Status.

## Update triggers

Обновляйте владеющий документ в том же slice, если меняются:

- process/session/poller ownership и runtime topology;
- SQLite schema, transaction boundary, retention или migration;
- MCP tool/transport/session/cancellation contract;
- bot agent/tool/output/durability contract;
- provider protocols, endpoint/security или config/env keys;
- systemd, logging, backup, cutover или rollback;
- module ownership, imports, facades и architecture gates;
- команды, которые копирует оператор или следующий агент.

## Не делать

- Не помещать active TODO, goal prompt, implementation checklist, временный
  audit/research log или completion evidence в `docs/`.
- Не описывать непроверенное поведение как текущее.
- Не дублировать длинную verification matrix в нескольких документах:
  канонический routing находится в `AGENTS.md`.
- Не превращать один чат-бот в generated-map/passport платформу без
  воспроизводимой проблемы drift.
- Не публиковать секреты, реальные tokens/session strings, private headers или
  сырые provider payloads.

## Verification

Docs-only:

```bash
git diff --check
npm run check:architecture
```

Если docs сопровождают code change, используйте completion owner из
`AGENTS.md`; эта rule не поддерживает вторую копию code gates.

## Size budgets

- Always-on контракт (AGENTS.md): ≤ 200 строк.
- Детальное правило (.agents/rules/*.md): ≤ 500 строк.
- При росте — split по trigger, не по вендору.
