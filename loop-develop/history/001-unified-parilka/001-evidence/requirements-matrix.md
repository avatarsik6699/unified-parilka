# Goal 001 requirements matrix

Матрица связывает исходные формулировки пользователя с проверяемым
результатом. Статус `in progress` не считается выполнением goal.

| Requirement | Реализация/evidence | Gate | Status |
| --- | --- | --- | --- |
| Найти оба локальных проекта и понять production shape | Baseline в `audit-2026-07-30.md`; legacy paths и services перечислены в runbook | Read-only runtime/DB inspection | done |
| Самостоятельно выбрать TypeScript либо Go без вкусовщины | ADR 0001 и `peer-comparison.md`: TS выбран по общему type graph; Go оставлен только за измеренным MTProto trigger | Peer source comparison | done |
| Объединить bot и Telegram Parilka MCP | Один repository, schema v13, два явных process owner и один canonical SQLite | Build, tests, MCP smokes | done |
| Сразу нормально декомпозировать большие файлы | Domain modules, thin compatibility barrels, 700-line fail-closed gate для `src/` и production CLI | `npm run check:architecture` | done |
| Оставить запас под новые функции без overengineering | Domain-local extension points; без DI container/event bus/Redis/generic plugin system | Architecture review | done |
| Стабильность и crash durability | Durable update/turn/outbox FSM, leases, send fence, one-owner guards, bounded retries/cancellation | Focused failure tests + full suite | done |
| Отслеживаемость багов | Structured redacted logs и trace correlation по update/turn/provider/tool | Observability tests + final review | done |
| Логи/служебное состояние не растут бесконечно | journald вместо append-only app logs; bounded history/bot/outbox retention и WAL visibility | Maintenance rehearsal | done |
| Скорость и отсутствие фоновых стопоров | Bounded hybrid search; embedding cadence отделён от history tick и ограничен hard budget | Vector benchmark + cadence tests | done |
| Заменяемые provider subscriptions/endpoints | Startup-validated role/candidate config, env-only credentials/custom headers, OpenAI/Anthropic protocols и ordered fallback | Router tests | done |
| Улучшить agent loop и tools | Четыре read-only bot tools, общий execution budget, forced final, deadlines, untrusted-evidence wrapper; отдельные 13 operator MCP tools | Agent/tool tests + red-team | done |
| Проверить похожие проекты именно на уровне кода | Pinned grammY/Telegent/mcp-telegram/Chigwell/mtcute/gotd/Pino исходники и построчное сравнение | `peer-comparison.md` links | done |
| Перенести архитектуру docs и агентной разработки из `nareshka-mono` | Root router, `llms.txt`, progressive rules, durable docs/ADR, operations lane, один active goal/evidence/history | Docs link/architecture gate | done |
| Не копировать monorepo-overengineering | Осознанно исключены passports/generated maps/frontend/Go/deploy layers без локального drift | `nareshka-workflow-study.md` | done |
| Закрыть security/correctness races | Atomic embedding source commit, digest prefix proof, bounded provider/network inputs, exclusive MTProto recovery guard | Regression tests + independent re-review | done |
| Доказать migration/maintenance/digest path | Свежие consistent snapshots, final target от latest MCP snapshot, idempotence, quick_check/count/range/hash evidence | Offline rehearsal | done |
| Полное финальное ревью | Повторные независимые security/architecture/operations reviews без открытых P0/P1 | Review evidence + all gates | done |
| Автономно заменить runtime после полной готовности | После rehearsal/review/gates остановить legacy Parilka owners, установить/enable unified units и обновить только canonical Parilka MCP target | systemd + mcp-sync + runtime health | done |
| Проверить через Telegram account реальным тегом бота | Одно маркированное group message через Telegram MCP, подтверждённый bot reply и коррелированный journal/SQLite trace | Live E2E evidence | done |
| Не затронуть соседние системы | Общий Telegram MCP `127.0.0.1:8765`, чужие services, remote Git и значения secrets остаются без изменений | Before/after inventory | done |
